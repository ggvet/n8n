import { RunnableConfig } from '@langchain/core/runnables';
import { type Checkpoint, MemorySaver } from '@langchain/langgraph';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import type { INodeTypeDescription } from 'n8n-workflow';

import { getBuilderToolsForDisplay } from '@/tools/builder-tools';
import { ISessionStorage } from '@/types/session-storage';
import { isLangchainMessagesArray, LangchainMessage, Session } from '@/types/sessions';
import { stripAllCacheControlMarkers } from '@/utils/cache-control/helpers';
import { formatMessages } from '@/utils/stream-processor';

@Service()
export class SessionManagerService {
	private checkpointer: MemorySaver;

	private nodeTypes: INodeTypeDescription[];

	constructor(
		parsedNodeTypes: INodeTypeDescription[],
		private readonly storage?: ISessionStorage,
		private readonly logger?: Logger,
	) {
		this.nodeTypes = parsedNodeTypes;
		this.checkpointer = new MemorySaver();

		if (storage) {
			this.logger?.debug('Using persistent session storage');
		} else {
			this.logger?.debug('Using in-memory session storage (MemorySaver)');
		}
	}

	/**
	 * Whether persistent storage is configured
	 */
	get usesPersistence(): boolean {
		return !!this.storage;
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

	/**
	 * Load session messages from persistent storage.
	 * Called before starting a chat to get historical messages to include in the initial state.
	 * Returns the messages so they can be passed explicitly to the stream's initial state.
	 *
	 * Note: Strips all cache_control markers from loaded messages to prevent exceeding
	 * Anthropic's 4 cache_control block limit when combined with fresh system prompts.
	 */
	async loadSessionMessages(threadId: string): Promise<LangchainMessage[]> {
		if (!this.storage) return [];

		const stored = await this.storage.getSession(threadId);
		if (!stored || stored.messages.length === 0) return [];

		// Strip cache_control markers from historical messages to prevent exceeding
		// Anthropic's 4 cache_control block limit when combined with new system prompts
		stripAllCacheControlMarkers(stored.messages);

		this.logger?.debug('Loaded session messages from storage', {
			threadId,
			messageCount: stored.messages.length,
		});

		return stored.messages;
	}

	/**
	 * Save the current checkpointer state to persistent storage.
	 * Called after a chat completes to persist the final state.
	 */
	async saveSessionFromCheckpointer(threadId: string, previousSummary?: string): Promise<void> {
		if (!this.storage) return;

		const threadConfig: RunnableConfig = {
			configurable: { thread_id: threadId },
		};

		const checkpointTuple = await this.checkpointer.getTuple(threadConfig);
		if (!checkpointTuple?.checkpoint) return;

		const rawMessages = checkpointTuple.checkpoint.channel_values?.messages;
		const messages: LangchainMessage[] = isLangchainMessagesArray(rawMessages) ? rawMessages : [];

		await this.storage.saveSession(threadId, {
			messages,
			previousSummary,
			updatedAt: new Date(),
		});

		this.logger?.debug('Saved session from checkpointer', {
			threadId,
			messageCount: messages.length,
		});
	}

	/**
	 * Get the previous summary from persistent storage
	 */
	async getPreviousSummary(threadId: string): Promise<string | undefined> {
		if (!this.storage) return undefined;

		const stored = await this.storage.getSession(threadId);
		return stored?.previousSummary;
	}

	/**
	 * Clear session from persistent storage.
	 *
	 * Note: The in-memory MemorySaver checkpointer doesn't support deletion of individual
	 * thread states. However, this is acceptable because:
	 * 1. When persistent storage is enabled, loadSessionMessages() loads from storage (which is cleared)
	 * 2. The in-memory state will be overwritten on the next chat interaction
	 * 3. MemorySaver is only used for within-session state, not cross-session persistence
	 */
	async clearSession(threadId: string): Promise<void> {
		// Clear from persistent storage if available
		if (this.storage) {
			await this.storage.deleteSession(threadId);
		}

		this.logger?.debug('Session cleared', { threadId });
	}

	/**
	 * Get sessions for a given workflow and user
	 */
	async getSessions(
		workflowId: string | undefined,
		userId: string | undefined,
	): Promise<{ sessions: Session[] }> {
		const sessions: Session[] = [];

		if (!workflowId) {
			return { sessions };
		}

		const threadId = SessionManagerService.generateThreadId(workflowId, userId);

		// Try persistent storage first if available
		if (this.storage) {
			const stored = await this.storage.getSession(threadId);
			if (stored && stored.messages.length > 0) {
				const formattedMessages = formatMessages(
					stored.messages,
					getBuilderToolsForDisplay({ nodeTypes: this.nodeTypes }),
				);

				sessions.push({
					sessionId: threadId,
					messages: formattedMessages,
					lastUpdated: stored.updatedAt.toISOString(),
				});

				return { sessions };
			}
		}

		// Fall back to in-memory checkpointer
		const threadConfig: RunnableConfig = {
			configurable: { thread_id: threadId },
		};

		try {
			const checkpoint = await this.checkpointer.getTuple(threadConfig);

			if (checkpoint?.checkpoint) {
				const rawMessages = checkpoint.checkpoint.channel_values?.messages;
				const messages: LangchainMessage[] = isLangchainMessagesArray(rawMessages)
					? rawMessages
					: [];

				const formattedMessages = formatMessages(
					messages,
					getBuilderToolsForDisplay({ nodeTypes: this.nodeTypes }),
				);

				sessions.push({
					sessionId: threadId,
					messages: formattedMessages,
					lastUpdated: checkpoint.checkpoint.ts,
				});
			}
		} catch (error) {
			this.logger?.debug('No session found for workflow:', { workflowId, error });
		}

		return { sessions };
	}

	/**
	 * Truncate all messages including and after the message with the specified messageId in metadata.
	 * Used when restoring to a previous version.
	 */
	async truncateMessagesAfter(
		workflowId: string,
		userId: string | undefined,
		messageId: string,
	): Promise<boolean> {
		const threadId = SessionManagerService.generateThreadId(workflowId, userId);

		try {
			// Get messages from the appropriate source
			// Both sources provide LangchainMessage[] (StoredSession.messages or type-guarded rawMessages)
			let messages: LangchainMessage[] = [];
			let previousSummary: string | undefined;

			if (this.storage) {
				const stored = await this.storage.getSession(threadId);
				if (!stored) {
					this.logger?.debug('No stored session found for truncation', { threadId, messageId });
					return false;
				}
				messages = stored.messages;
				previousSummary = stored.previousSummary;
			} else {
				const threadConfig: RunnableConfig = {
					configurable: { thread_id: threadId },
				};

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
				messages = rawMessages;
			}

			// Find the index of the message with the target messageId
			const msgIndex = messages.findIndex((msg) => msg.additional_kwargs?.messageId === messageId);

			if (msgIndex === -1) {
				this.logger?.debug('Message with messageId not found', { threadId, messageId });
				return false;
			}

			// Keep messages before the target message
			const truncatedMessages = messages.slice(0, msgIndex);

			// Update persistent storage if available
			if (this.storage) {
				await this.storage.saveSession(threadId, {
					messages: truncatedMessages,
					previousSummary,
					updatedAt: new Date(),
				});
			}

			// Also update the in-memory checkpointer
			const threadConfig: RunnableConfig = {
				configurable: { thread_id: threadId },
			};

			const checkpointTuple = await this.checkpointer.getTuple(threadConfig);
			if (checkpointTuple?.checkpoint) {
				const updatedCheckpoint: Checkpoint = {
					...checkpointTuple.checkpoint,
					channel_values: {
						...checkpointTuple.checkpoint.channel_values,
						messages: truncatedMessages,
					},
				};

				const metadata = checkpointTuple.metadata ?? {
					source: 'update' as const,
					step: -1,
					parents: {},
				};

				await this.checkpointer.put(threadConfig, updatedCheckpoint, metadata);
			}

			this.logger?.debug('Messages truncated successfully', {
				threadId,
				messageId,
				originalCount: messages.length,
				newCount: truncatedMessages.length,
			});

			return true;
		} catch (error) {
			this.logger?.error('Failed to truncate messages', {
				threadId,
				messageId,
				error,
			});
			return false;
		}
	}
}
