import { BaseChatHistory } from './base-chat-history';
import type { Message } from '../types/message';

class InMemoryChatHistoryManager {
	private static instance: InMemoryChatHistoryManager;

	private sessions: Map<
		string,
		{
			messages: Message[];
			createdAt: Date;
			lastAccessedAt: Date;
		}
	>;

	private constructor() {
		this.sessions = new Map();
	}

	static getInstance(): InMemoryChatHistoryManager {
		if (!InMemoryChatHistoryManager.instance) {
			InMemoryChatHistoryManager.instance = new InMemoryChatHistoryManager();
		}
		return InMemoryChatHistoryManager.instance;
	}

	static resetInstance(): void {
		if (InMemoryChatHistoryManager.instance) {
			InMemoryChatHistoryManager.instance.sessions.clear();
		}
	}

	getSession(sessionId: string): Message[] {
		this.cleanupStaleSessions();

		let session = this.sessions.get(sessionId);
		if (!session) {
			session = {
				messages: [],
				createdAt: new Date(),
				lastAccessedAt: new Date(),
			};
			this.sessions.set(sessionId, session);
		} else {
			session.lastAccessedAt = new Date();
		}
		return session.messages;
	}

	clearSession(sessionId: string): void {
		this.sessions.delete(sessionId);
	}

	private cleanupStaleSessions(): void {
		const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

		const sessionIds = Array.from(this.sessions.keys());
		for (const sessionId of sessionIds) {
			const session = this.sessions.get(sessionId);
			if (session && session.lastAccessedAt < oneHourAgo) {
				this.sessions.delete(sessionId);
			}
		}
	}
}

/** Reset all in-memory sessions. For testing only. */
export function resetInMemoryChatHistorySessions(): void {
	InMemoryChatHistoryManager.resetInstance();
}

/** In-memory storage with session isolation. Messages are lost on restart. */
export class InMemoryChatHistory extends BaseChatHistory {
	private readonly sessionId: string;
	private readonly manager: InMemoryChatHistoryManager;

	constructor(sessionId: string) {
		super();
		this.sessionId = sessionId;
		this.manager = InMemoryChatHistoryManager.getInstance();
	}

	async getMessages(): Promise<Message[]> {
		const messages = this.manager.getSession(this.sessionId);
		return [...messages];
	}

	async addMessage(message: Message): Promise<void> {
		const messages = this.manager.getSession(this.sessionId);
		messages.push(message);
	}

	async addMessages(messages: Message[]): Promise<void> {
		const sessionMessages = this.manager.getSession(this.sessionId);
		sessionMessages.push(...messages);
	}

	async clear(): Promise<void> {
		this.manager.clearSession(this.sessionId);
	}
}
