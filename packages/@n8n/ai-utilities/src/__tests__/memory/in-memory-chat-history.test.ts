import {
	InMemoryChatHistory,
	resetInMemoryChatHistorySessions,
} from '../../memory/in-memory-chat-history';
import type { Message } from '../../types/message';

describe('InMemoryChatHistory', () => {
	const createMessage = (role: 'human' | 'ai', text: string): Message => ({
		role,
		content: [{ type: 'text', text }],
	});

	afterEach(() => {
		resetInMemoryChatHistorySessions();
	});

	describe('getMessages', () => {
		it('should return empty array initially', async () => {
			const history = new InMemoryChatHistory('test-session-1');
			const messages = await history.getMessages();
			expect(messages).toEqual([]);
		});

		it('should return a copy of messages', async () => {
			const history = new InMemoryChatHistory('test-session-copy');
			await history.addMessage(createMessage('human', 'Hello'));

			const messages1 = await history.getMessages();
			const messages2 = await history.getMessages();

			expect(messages1).not.toBe(messages2);
			expect(messages1).toEqual(messages2);
		});
	});

	describe('addMessage', () => {
		it('should store a single message', async () => {
			const history = new InMemoryChatHistory('test-session-2');
			const message = createMessage('human', 'Hello');

			await history.addMessage(message);

			const messages = await history.getMessages();
			expect(messages).toHaveLength(1);
			expect(messages[0]).toEqual(message);
		});

		it('should store multiple messages in order', async () => {
			const history = new InMemoryChatHistory('test-session-3');
			const msg1 = createMessage('human', 'Hello');
			const msg2 = createMessage('ai', 'Hi there!');

			await history.addMessage(msg1);
			await history.addMessage(msg2);

			const messages = await history.getMessages();
			expect(messages).toHaveLength(2);
			expect(messages[0]).toEqual(msg1);
			expect(messages[1]).toEqual(msg2);
		});
	});

	describe('addMessages', () => {
		it('should store multiple messages at once', async () => {
			const history = new InMemoryChatHistory('test-session-4');
			const msgs = [
				createMessage('human', 'Hello'),
				createMessage('ai', 'Hi there!'),
				createMessage('human', 'How are you?'),
			];

			await history.addMessages(msgs);

			const messages = await history.getMessages();
			expect(messages).toHaveLength(3);
			expect(messages).toEqual(msgs);
		});
	});

	describe('clear', () => {
		it('should remove all messages', async () => {
			const history = new InMemoryChatHistory('test-session-5');
			await history.addMessage(createMessage('human', 'Hello'));
			await history.addMessage(createMessage('ai', 'Hi!'));

			await history.clear();

			const messages = await history.getMessages();
			expect(messages).toEqual([]);
		});
	});

	describe('session isolation', () => {
		it('should isolate messages between different sessions', async () => {
			const history1 = new InMemoryChatHistory('session-a');
			const history2 = new InMemoryChatHistory('session-b');

			await history1.addMessage(createMessage('human', 'Message for session A'));
			await history2.addMessage(createMessage('human', 'Message for session B'));

			const messages1 = await history1.getMessages();
			const messages2 = await history2.getMessages();

			expect(messages1).toHaveLength(1);
			expect(messages1[0].content[0]).toEqual({ type: 'text', text: 'Message for session A' });

			expect(messages2).toHaveLength(1);
			expect(messages2[0].content[0]).toEqual({ type: 'text', text: 'Message for session B' });
		});

		it('should share messages for same session ID', async () => {
			const history1 = new InMemoryChatHistory('shared-session');
			const history2 = new InMemoryChatHistory('shared-session');

			await history1.addMessage(createMessage('human', 'First message'));

			const messages2 = await history2.getMessages();
			expect(messages2).toHaveLength(1);
			expect(messages2[0].content[0]).toEqual({ type: 'text', text: 'First message' });
		});
	});
});
