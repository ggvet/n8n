/**
 * Code Workflow Builder
 *
 * Public entry point for the workflow generation system.
 *
 * Architecture:
 * Uses a unified CodeBuilderAgent that combines node discovery and code generation
 * in a single agentic loop, preserving full context throughout the process.
 *
 * Session Management:
 * Supports multi-turn conversations through session persistence. User messages are
 * stored and can be compacted when the count exceeds a threshold. This allows users
 * to make incremental refinement requests without re-explaining the whole workflow.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { MemorySaver } from '@langchain/langgraph';
import type { Logger } from '@n8n/backend-common';
import type { INodeTypeDescription } from 'n8n-workflow';

import { CodeBuilderAgent } from './code-builder-agent';
import type { EvaluationLogger } from '../utils/evaluation-logger';
import type { StreamOutput, SessionMessagesChunk } from '../types/streaming';
import type { ChatPayload } from '../workflow-builder-agent';
import {
	loadCodeBuilderSession,
	saveCodeBuilderSession,
	compactSessionIfNeeded,
	generateCodeBuilderThreadId,
	saveSessionMessages,
} from './utils/code-builder-session';

/**
 * Configuration for CodeWorkflowBuilder
 */
export interface CodeWorkflowBuilderConfig {
	/** LLM for workflow generation */
	llm: BaseChatModel;
	/** Parsed node types from n8n */
	nodeTypes: INodeTypeDescription[];
	/** Optional logger */
	logger?: Logger;
	/**
	 * Path to the generated types directory (from InstanceSettings.generatedTypesDir).
	 * If not provided, falls back to workflow-sdk static types.
	 */
	generatedTypesDir?: string;
	/** Optional evaluation logger for capturing debug info during evals */
	evalLogger?: EvaluationLogger;
	/**
	 * Optional checkpointer for session persistence.
	 * If provided, enables multi-turn conversation history.
	 */
	checkpointer?: MemorySaver;
}

/**
 * Code Workflow Builder
 *
 * Generates n8n workflows using a unified CodeBuilderAgent that handles
 * both node discovery and code generation in a single pass.
 *
 * Supports multi-turn conversations through session persistence when a
 * checkpointer is provided.
 */
export class CodeWorkflowBuilder {
	private codeBuilderAgent: CodeBuilderAgent;
	private llm: BaseChatModel;
	private logger?: Logger;
	private checkpointer?: MemorySaver;

	constructor(config: CodeWorkflowBuilderConfig) {
		this.codeBuilderAgent = new CodeBuilderAgent({
			llm: config.llm,
			nodeTypes: config.nodeTypes,
			logger: config.logger,
			generatedTypesDir: config.generatedTypesDir,
			evalLogger: config.evalLogger,
			enableTextEditor: true,
		});

		this.llm = config.llm;
		this.logger = config.logger;
		this.checkpointer = config.checkpointer;
	}

	/**
	 * Main chat method - generates workflow from user request
	 *
	 * @param payload - Chat payload with message and workflow context
	 * @param userId - User ID for logging
	 * @param abortSignal - Optional abort signal
	 * @yields StreamOutput chunks for messages, tool progress, and workflow updates
	 */
	async *chat(
		payload: ChatPayload,
		userId: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<StreamOutput, void, unknown> {
		// Extract actual workflow ID from context (payload.id is the message/request ID)
		const workflowId = payload.workflowContext?.currentWorkflow?.id;

		this.logger?.debug('CodeWorkflowBuilder starting', {
			userId,
			workflowId,
			messageLength: payload.message.length,
			hasCheckpointer: !!this.checkpointer,
		});

		// Load and manage session if checkpointer is available
		let historyContext: { userMessages: string[]; previousSummary?: string } | undefined;

		if (this.checkpointer && workflowId) {
			const threadId = generateCodeBuilderThreadId(workflowId, userId);

			// Load existing session
			let session = await loadCodeBuilderSession(this.checkpointer, threadId);

			this.logger?.debug('Loaded CodeBuilder session', {
				threadId,
				userMessagesCount: session.userMessages.length,
				hasPreviousSummary: !!session.previousSummary,
			});

			// Compact if needed (when messages exceed threshold)
			session = await compactSessionIfNeeded(session, this.llm);

			// Build history context for the agent
			if (session.userMessages.length > 0 || session.previousSummary) {
				historyContext = {
					userMessages: session.userMessages,
					previousSummary: session.previousSummary,
				};
			}

			// Track generation success and capture session messages
			let generationSucceeded = false;
			let sessionMessages: unknown[] | undefined;

			// Delegate to CodeBuilderAgent with history context
			for await (const chunk of this.codeBuilderAgent.chat(
				payload,
				userId,
				abortSignal,
				historyContext,
			)) {
				// Track success when workflow-updated chunk is received
				if (chunk.messages?.some((msg) => msg.type === 'workflow-updated')) {
					generationSucceeded = true;
				}

				// Capture session messages for persistence
				for (const msg of chunk.messages ?? []) {
					if (msg.type === 'session-messages') {
						sessionMessages = (msg as SessionMessagesChunk).messages;
					}
				}

				// Don't yield session-messages chunk to frontend (internal use only)
				const filteredMessages = chunk.messages?.filter((msg) => msg.type !== 'session-messages');
				if (filteredMessages && filteredMessages.length > 0) {
					yield { messages: filteredMessages };
				}
			}

			// Save current message to session after successful generation
			session.userMessages.push(payload.message);
			await saveCodeBuilderSession(this.checkpointer, threadId, session);

			// Save full message history to SessionManager thread for frontend retrieval
			if (generationSucceeded && sessionMessages) {
				await saveSessionMessages(
					this.checkpointer,
					workflowId,
					userId,
					sessionMessages,
					payload.versionId,
				);

				this.logger?.debug('Saved session messages to SessionManager thread', {
					workflowId,
					userId,
					messageCount: sessionMessages.length,
				});
			}

			this.logger?.debug('Saved CodeBuilder session', {
				threadId,
				newMessageCount: session.userMessages.length,
			});
		} else {
			// No session management - delegate directly
			yield* this.codeBuilderAgent.chat(payload, userId, abortSignal);
		}
	}
}

/**
 * Factory function to create a CodeWorkflowBuilder
 */
export function createCodeWorkflowBuilder(
	llm: BaseChatModel,
	nodeTypes: INodeTypeDescription[],
	options?: {
		logger?: Logger;
		generatedTypesDir?: string;
	},
): CodeWorkflowBuilder {
	return new CodeWorkflowBuilder({
		llm,
		nodeTypes,
		logger: options?.logger,
		generatedTypesDir: options?.generatedTypesDir,
	});
}
