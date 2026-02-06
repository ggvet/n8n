import { RunnableConfig } from '@langchain/core/runnables';
import { type Checkpoint, MemorySaver } from '@langchain/langgraph';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import type { INodeTypeDescription } from 'n8n-workflow';

import { getBuilderToolsForDisplay } from '@/tools/builder-tools';
import type { HITLInterruptValue, QuestionsInterruptValue } from '@/types/planning';
import { isLangchainMessagesArray, LangchainMessage, Session } from '@/types/sessions';
import { formatMessages } from '@/utils/stream-processor';

@Service()
export class SessionManagerService {
	private checkpointer: MemorySaver;

	private nodeTypes: INodeTypeDescription[];

	private static readonly HITL_TTL_MS = 24 * 60 * 60 * 1000; // 1 day

	private pendingHitlByThreadId = new Map<
		string,
		{ value: HITLInterruptValue; expiresAt: number }
	>();

	/** Stores answered questions for session replay (not persisted in LangGraph checkpoint) */
	private answeredQuestionsByThreadId = new Map<
		string,
		Array<{ questions: QuestionsInterruptValue; answers: unknown }>
	>();

	constructor(
		parsedNodeTypes: INodeTypeDescription[],
		private readonly logger?: Logger,
	) {
		this.nodeTypes = parsedNodeTypes;
		this.checkpointer = new MemorySaver();
	}

	/**
	 * Update the node types used for formatting messages.
	 * Called when community packages are installed, updated, or uninstalled.
	 */
	updateNodeTypes(nodeTypes: INodeTypeDescription[]) {
		this.nodeTypes = nodeTypes;
	}

	/**
	 * Generate a thread ID for a given workflow and user
	 */
	static generateThreadId(workflowId?: string, userId?: string): string {
		return workflowId
			? `workflow-${workflowId}-user-${userId ?? new Date().getTime()}`
			: crypto.randomUUID();
	}

	/**
	 * Get the checkpointer instance
	 */
	getCheckpointer(): MemorySaver {
		return this.checkpointer;
	}

	setPendingHitl(threadId: string, value: HITLInterruptValue) {
		this.evictExpiredHitl();
		this.pendingHitlByThreadId.set(threadId, {
			value,
			expiresAt: Date.now() + SessionManagerService.HITL_TTL_MS,
		});
	}

	clearPendingHitl(threadId: string) {
		this.pendingHitlByThreadId.delete(threadId);
	}

	/**
	 * Atomically get and clear the pending HITL value for a thread.
	 * Prevents TOCTOU races between separate get + clear calls.
	 */
	getAndClearPendingHitl(threadId: string): HITLInterruptValue | undefined {
		const value = this.getPendingHitl(threadId);
		if (value) {
			this.pendingHitlByThreadId.delete(threadId);
		}
		return value;
	}

	getPendingHitl(threadId: string): HITLInterruptValue | undefined {
		this.evictExpiredHitl();
		const entry = this.pendingHitlByThreadId.get(threadId);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.pendingHitlByThreadId.delete(threadId);
			return undefined;
		}
		return entry.value;
	}

	/**
	 * Store answered questions for session replay.
	 * Called when a questions interrupt is resumed with answers.
	 */
	addAnsweredQuestions(threadId: string, questions: QuestionsInterruptValue, answers: unknown) {
		const existing = this.answeredQuestionsByThreadId.get(threadId) ?? [];
		existing.push({ questions, answers });
		this.answeredQuestionsByThreadId.set(threadId, existing);
	}

	getAnsweredQuestions(
		threadId: string,
	): Array<{ questions: QuestionsInterruptValue; answers: unknown }> {
		return this.answeredQuestionsByThreadId.get(threadId) ?? [];
	}

	private evictExpiredHitl() {
		const now = Date.now();
		for (const [id, entry] of this.pendingHitlByThreadId) {
			if (now > entry.expiresAt) {
				this.pendingHitlByThreadId.delete(id);
			}
		}
	}

	/**
	 * Get sessions for a given workflow and user
	 */
	async getSessions(
		workflowId: string | undefined,
		userId: string | undefined,
	): Promise<{ sessions: Session[] }> {
		// For now, we'll return the current session if we have a workflowId
		// MemorySaver doesn't expose a way to list all threads, so we'll need to
		// track this differently if we want to list all sessions
		const sessions: Session[] = [];

		if (workflowId) {
			const threadId = SessionManagerService.generateThreadId(workflowId, userId);
			const threadConfig: RunnableConfig = {
				configurable: {
					thread_id: threadId,
				},
			};

			try {
				// Try to get the checkpoint for this thread
				const checkpoint = await this.checkpointer.getTuple(threadConfig);

				if (checkpoint?.checkpoint) {
					const rawMessages = checkpoint.checkpoint.channel_values?.messages;
					const messages: LangchainMessage[] = isLangchainMessagesArray(rawMessages)
						? rawMessages
						: [];

					const formattedMessages = formatMessages(
						messages,
						getBuilderToolsForDisplay({
							nodeTypes: this.nodeTypes,
						}),
					);

					// Inject answered questions that aren't in the checkpoint
					// (Command.update messages don't persist across subgraph interrupts)
					const answeredQuestions = this.getAnsweredQuestions(threadId);
					for (const { questions, answers } of answeredQuestions) {
						formattedMessages.push({
							role: 'assistant',
							type: 'questions',
							questions: questions.questions,
							...(questions.introMessage ? { introMessage: questions.introMessage } : {}),
						});
						formattedMessages.push({
							role: 'user',
							type: 'user_answers',
							answers,
						});
					}

					const pendingHitl = this.getPendingHitl(threadId);
					if (pendingHitl) {
						formattedMessages.push({
							role: 'assistant',
							type: pendingHitl.type,
							...(pendingHitl.type === 'questions'
								? {
										questions: pendingHitl.questions,
										...(pendingHitl.introMessage ? { introMessage: pendingHitl.introMessage } : {}),
									}
								: {
										plan: pendingHitl.plan,
									}),
						});
					}

					sessions.push({
						sessionId: threadId,
						messages: formattedMessages,
						lastUpdated: checkpoint.checkpoint.ts,
					});
				}
			} catch (error) {
				// Thread doesn't exist yet
				this.logger?.debug('No session found for workflow:', { workflowId, error });
			}
		}

		return { sessions };
	}

	/**
	 * Truncate all messages including and after the message with the specified messageId in metadata.
	 * Used when restoring to a previous version.
	 *
	 * @param workflowId - The workflow ID
	 * @param userId - The user ID
	 * @param messageId - The messageId to find in HumanMessage's additional_kwargs. Messages from this
	 *                    point onward (including the message with this messageId) will be removed.
	 * @returns True if truncation was successful, false if thread or message not found
	 */
	async truncateMessagesAfter(
		workflowId: string,
		userId: string | undefined,
		messageId: string,
	): Promise<boolean> {
		const threadId = SessionManagerService.generateThreadId(workflowId, userId);
		const threadConfig: RunnableConfig = {
			configurable: {
				thread_id: threadId,
			},
		};

		try {
			const checkpointTuple = await this.checkpointer.getTuple(threadConfig);

			if (!checkpointTuple?.checkpoint) {
				this.logger?.debug('No checkpoint found for truncation', { threadId, messageId });
				return false;
			}

			const rawMessages = checkpointTuple.checkpoint.channel_values?.messages;
			if (!isLangchainMessagesArray(rawMessages)) {
				this.logger?.debug('No valid messages found for truncation', { threadId, messageId });
				return false;
			}

			// Find the index of the message with the target messageId in additional_kwargs
			const msgIndex = rawMessages.findIndex(
				(msg) => msg.additional_kwargs?.messageId === messageId,
			);

			if (msgIndex === -1) {
				this.logger?.debug('Message with messageId not found', { threadId, messageId });
				return false;
			}

			// Keep messages before the target message (excluding the target message)
			const truncatedMessages = rawMessages.slice(0, msgIndex);

			// Create updated checkpoint with truncated messages
			const updatedCheckpoint: Checkpoint = {
				...checkpointTuple.checkpoint,
				channel_values: {
					...checkpointTuple.checkpoint.channel_values,
					messages: truncatedMessages,
				},
			};

			// Put the updated checkpoint back with metadata indicating this is an update
			const metadata = checkpointTuple.metadata ?? {
				source: 'update' as const,
				step: -1,
				parents: {},
			};

			await this.checkpointer.put(threadConfig, updatedCheckpoint, metadata);

			this.logger?.debug('Messages truncated successfully', {
				threadId,
				messageId,
				originalCount: rawMessages.length,
				newCount: truncatedMessages.length,
			});

			return true;
		} catch (error) {
			this.logger?.error('Failed to truncate messages', { threadId, messageId, error });
			return false;
		}
	}
}
