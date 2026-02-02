import { Logger } from '@n8n/backend-common';
import { ExecutionsConfig } from '@n8n/config';
import { ExecutionRepository, type IExecutionResponse } from '@n8n/db';
import { OnLifecycleEvent, type WorkflowExecuteAfterContext } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { v4 as uuidv4 } from 'uuid';

import { ChatHubExecutionService } from './chat-hub-execution.service';
import { ChatHubExecutionStore, type ChatHubExecutionContext } from './chat-hub-execution.store';
import { ChatHubMessageRepository } from './chat-message.repository';
import { ChatStreamService } from './chat-stream.service';
import { getLastNodeExecuted, shouldResumeImmediately } from '../../chat/utils';

import { ChatExecutionManager } from '@/chat/chat-execution-manager';
import { EventService } from '@/events/event.service';

/**
 * Service responsible for handling execution lifecycle events for non-streaming
 * chat hub executions. This implements the event-driven architecture where:
 *
 * - execution-resumed event: Notifies frontend when a resumed execution starts
 * - workflowExecuteAfter: Handles all completion scenarios (success, error, waiting, auto-resume)
 *
 * This eliminates the blocking waitForExecutionCompletion() calls and provides
 * a unified code path for handling all execution outcomes.
 */
@Service()
export class ChatHubExecutionWatcherService {
	constructor(
		private readonly logger: Logger,
		private readonly executionStore: ChatHubExecutionStore,
		private readonly messageRepository: ChatHubMessageRepository,
		private readonly chatHubExecutionService: ChatHubExecutionService,
		private readonly executionRepository: ExecutionRepository,
		private readonly chatStreamService: ChatStreamService,
		private readonly executionManager: ChatExecutionManager,
		private readonly eventService: EventService,
		private readonly executionsConfig: ExecutionsConfig,
		private readonly instanceSettings: InstanceSettings,
	) {
		this.logger = this.logger.scoped('chat-hub');

		// Subscribe to execution-resumed events from ActiveExecutions
		this.eventService.on('execution-resumed', async (event) => {
			this.logger.debug(`Handling execution-resumed event for execution ${event.executionId}`);
			await this.handleExecutionResumed(event);
		});
	}

	/**
	 * Called when any execution resumes from waiting state.
	 * This catches ALL resumption scenarios:
	 * - Auto-resume from shouldResumeImmediately()
	 * - User sends message to waiting execution
	 * - WaitTracker timer expiration
	 * - External HITL webhooks (form submissions, etc.)
	 */
	private async handleExecutionResumed(event: {
		executionId: string;
		workflowId?: string;
	}): Promise<void> {
		const { executionId } = event;

		// Check if this is a tracked chat hub execution
		const context = await this.executionStore.get(executionId);
		if (!context) return;

		if (!context.isResuming) return;

		this.logger.debug(`Chat hub execution ${executionId} resumed, notifying frontend`);

		await this.executionStore.update(executionId, { isResuming: false });

		// Notify frontend that execution is running again
		await this.chatStreamService.startExecution(context.userId, context.sessionId);
		await this.chatStreamService.startStream({
			userId: context.userId,
			sessionId: context.sessionId,
			messageId: context.messageId,
			previousMessageId: context.previousMessageId,
			retryOfMessageId: null,
			executionId: parseInt(executionId, 10),
		});
	}

	/**
	 * Called when any workflow execution completes.
	 * Handles all non-streaming completion scenarios:
	 * - Initial execution completion (success/error)
	 * - Waiting state with auto-resume (shouldResumeImmediately)
	 * - Waiting state for external trigger
	 * - Resumed execution completion
	 */
	@OnLifecycleEvent('workflowExecuteAfter')
	async handleWorkflowExecuteAfter(ctx: WorkflowExecuteAfterContext): Promise<void> {
		const { runData, executionId } = ctx;

		const isQueueMode = this.executionsConfig.mode === 'queue';
		const isWorker = this.instanceSettings.isWorker;

		// In queue mode, only worker should process this event.
		// Mains also receive the event (via lifecycle hooks) but they should skip it
		// to prevent race conditions where both instances try to process.
		if (isQueueMode && !isWorker) {
			return;
		}

		this.logger.debug('workflowExecuteAfter received', { executionId });

		const context = await this.executionStore.get(executionId);
		if (!context) return; // Not a tracked chat hub execution

		this.logger.debug('Handling workflow execution completition', { executionId });

		if (!['success', 'waiting', 'canceled'].includes(runData.status)) {
			const errorMessage =
				this.chatHubExecutionService.getErrorMessage(runData) ?? 'Failed to generate a response';
			await this.pushErrorResults(context, errorMessage);
			await this.executionStore.remove(executionId);
			return;
		}

		if (runData.status === 'canceled') {
			await this.chatStreamService.endExecution(context.userId, context.sessionId, 'cancelled');
			await this.executionStore.remove(executionId);
			return;
		}

		const message = this.chatHubExecutionService.getMessageFromRunData(
			runData,
			context.responseMode,
		);

		if (runData.status === 'waiting') {
			await this.handleWaitingExecution(context, executionId, message);
			return;
		}

		if (runData.finished) {
			await this.pushFinalResults(context, message);
			await this.executionStore.remove(executionId);
		}
	}

	/**
	 * Handle execution that has entered waiting state
	 */
	private async handleWaitingExecution(
		context: ChatHubExecutionContext,
		executionId: string,
		message: string | undefined,
	): Promise<void> {
		// Update message with current content and waiting status
		await this.messageRepository.updateChatMessage(context.messageId, {
			content: message ?? '',
			status: 'waiting',
		});

		if (message) {
			await this.chatStreamService.sendChunk(context.sessionId, context.messageId, message);
		}

		await this.chatStreamService.endStream(context.sessionId, context.messageId, 'waiting');
		await this.chatStreamService.endExecution(context.userId, context.sessionId, 'success');

		// Check if we should auto-resume (responseNodes mode only)
		if (context.responseMode === 'responseNodes') {
			const execution = await this.executionRepository.findSingleExecution(executionId, {
				includeData: true,
				unflattenData: true,
			});

			if (execution) {
				const lastNode = getLastNodeExecuted(execution);
				if (lastNode && shouldResumeImmediately(lastNode)) {
					await this.triggerAutoResume(context, execution);
					return;
				}
			}
		}

		// Not auto-resuming - mark context as "resuming"
		await this.executionStore.markAsResuming(executionId);
	}

	/**
	 * Trigger auto-resume for responseNodes mode when the last node doesn't require user input
	 */
	private async triggerAutoResume(
		context: ChatHubExecutionContext,
		execution: IExecutionResponse,
	): Promise<void> {
		this.logger.debug(`Auto-resuming execution ${execution.id}`);

		// Mark current message as success (not waiting) since we're continuing
		await this.messageRepository.updateChatMessage(context.messageId, { status: 'success' });

		// Create new message for the next response
		const newMessageId = uuidv4();
		await this.createNextMessage(context, newMessageId, execution.id);

		// Update context with new message ID and mark as waiting
		await this.executionStore.update(execution.id, {
			previousMessageId: context.messageId,
			messageId: newMessageId,
			isResuming: true,
		});

		// Trigger resume (non-blocking - lifecycle events will handle the rest)
		void this.executionManager.runWorkflow(execution, {
			action: 'sendMessage',
			chatInput: '', // No new human input for auto-resume
			sessionId: context.sessionId,
		});
	}

	/**
	 * Create a new AI message for the next segment of a resumed execution
	 */
	private async createNextMessage(
		context: ChatHubExecutionContext,
		messageId: string,
		executionId: string,
	): Promise<void> {
		await this.messageRepository.createChatMessage({
			id: messageId,
			sessionId: context.sessionId,
			previousMessageId: context.messageId,
			executionId: parseInt(executionId, 10),
			type: 'ai',
			name: 'AI',
			status: 'running',
			content: '',
			retryOfMessageId: null,
			...context.model,
		});
	}

	/**
	 * Push final successful results to frontend and database
	 */
	private async pushFinalResults(
		context: ChatHubExecutionContext,
		message: string | undefined,
	): Promise<void> {
		// Send final content via WebSocket
		if (message) {
			await this.chatStreamService.sendChunk(context.sessionId, context.messageId, message);
		}

		// End stream and execution
		await this.chatStreamService.endStream(context.sessionId, context.messageId, 'success');
		await this.chatStreamService.endExecution(context.userId, context.sessionId, 'success');

		// Update message in DB
		await this.messageRepository.updateChatMessage(context.messageId, {
			content: message ?? '',
			status: 'success',
		});
	}

	/**
	 * Push error results to frontend and database
	 */
	private async pushErrorResults(
		context: ChatHubExecutionContext,
		errorMessage: string,
	): Promise<void> {
		// Send error via WebSocket
		await this.chatStreamService.sendChunk(context.sessionId, context.messageId, errorMessage);

		// End stream and execution with error status
		await this.chatStreamService.endStream(context.sessionId, context.messageId, 'error');
		await this.chatStreamService.endExecution(context.userId, context.sessionId, 'error');

		// Update message in DB
		await this.messageRepository.updateChatMessage(context.messageId, {
			content: errorMessage,
			status: 'error',
		});
	}
}
