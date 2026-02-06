import { BaseChatMemory as LangchainBaseChatMemory } from '@langchain/community/memory/chat_memory';
import { BaseListChatMessageHistory } from '@langchain/core/chat_history';
import type { InputValues, MemoryVariables, OutputValues } from '@langchain/core/memory';
import type { BaseMessage } from '@langchain/core/messages';

import { fromLcMessage, toLcMessage } from '../converters/message';
import type { ChatHistory, ChatMemory } from '../types/memory';

class LangchainHistoryAdapter extends BaseListChatMessageHistory {
	lc_namespace = ['n8n', 'ai-utilities'];

	constructor(private readonly n8nHistory: ChatHistory) {
		super();
	}

	async getMessages(): Promise<BaseMessage[]> {
		const messages = await this.n8nHistory.getMessages();
		return messages.map(toLcMessage);
	}

	async addMessage(message: BaseMessage): Promise<void> {
		await this.n8nHistory.addMessage(fromLcMessage(message));
	}

	async addMessages(messages: BaseMessage[]): Promise<void> {
		await this.n8nHistory.addMessages(messages.map(fromLcMessage));
	}

	async clear(): Promise<void> {
		await this.n8nHistory.clear();
	}
}

export class LangchainMemoryAdapter extends LangchainBaseChatMemory {
	private readonly memory: ChatMemory;

	constructor(memory: ChatMemory) {
		super({
			chatHistory: new LangchainHistoryAdapter(memory.chatHistory),
			returnMessages: true,
			inputKey: 'input',
			outputKey: 'output',
		});
		this.memory = memory;
	}

	get memoryKeys(): string[] {
		return ['chat_history'];
	}

	async loadMemoryVariables(_values: InputValues): Promise<MemoryVariables> {
		const messages = await this.memory.loadMessages();
		return {
			chat_history: messages.map(toLcMessage),
		};
	}

	async saveContext(inputValues: InputValues, outputValues: OutputValues): Promise<void> {
		const input = inputValues.input as string;
		const output = outputValues.output as string;
		await this.memory.saveContext(input, output);
	}

	async clear(): Promise<void> {
		await this.memory.clear();
	}
}
