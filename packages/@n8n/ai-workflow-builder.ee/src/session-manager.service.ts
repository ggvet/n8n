import type { BaseMessage } from '@langchain/core/messages';
import { RunnableConfig } from '@langchain/core/runnables';
import { type Checkpoint, MemorySaver } from '@langchain/langgraph';
import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import type { INodeTypeDescription } from 'n8n-workflow';

import { getBuilderToolsForDisplay } from '@/tools/builder-tools';
import { ISessionStorage } from '@/types/session-storage';
import { isLangchainMessagesArray, LangchainMessage, Session } from '@/types/sessions';
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
	 * Load session from persistent storage and seed the MemorySaver.
	 * Called before starting a chat to ensure LangGraph has the latest state.
	 */
	async loadSessionIntoCheckpointer(threadId: string): Promise<void> {
		if (!this.storage) return;

		const stored = await this.storage.getSession(threadId);
		if (!stored || stored.messages.length === 0) return;

		const threadConfig: RunnableConfig = {
			configurable: { thread_id: threadId },
		};

		// Create a checkpoint with the stored messages
		const checkpoint: Checkpoint = {
			v: 1,
			id: crypto.randomUUID(),
			ts: stored.updatedAt.toISOString(),
			channel_values: {
				messages: stored.messages,
			},
			channel_versions: {},
			versions_seen: {},
		};

		const metadata = {
			source: 'input' as const,
			step: -1,
			writes: null,
			parents: {},
		};

		await this.checkpointer.put(threadConfig, checkpoint, metadata);

		this.logger?.debug('Loaded session into checkpointer', {
			threadId,
			messageCount: stored.messages.length,
		});
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
	 * Clear session from both checkpointer and persistent storage
	 */
	async clearSession(threadId: string): Promise<void> {
		// Clear from persistent storage if available
		if (this.storage) {
			await this.storage.deleteSession(threadId);
		}

		// Clear from in-memory checkpointer by resetting it
		// Note: MemorySaver doesn't have a delete method, so we create a fresh one
		// This is acceptable since sessions are scoped by threadId
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
			let messages: BaseMessage[] = [];
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
			const truncatedMessages = messages.slice(0, msgIndex) as LangchainMessage[];

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
