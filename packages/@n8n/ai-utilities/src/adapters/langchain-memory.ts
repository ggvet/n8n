import { BaseChatMemory as LangchainBaseChatMemory } from '@langchain/community/memory/chat_memory';
import type { InputValues, MemoryVariables, OutputValues } from '@langchain/core/memory';

import { LangchainHistoryAdapter } from './langchain-history';
import { toLcMessage } from '../converters/message';
import type { ChatMemory } from '../types/memory';

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
		const input = String(inputValues.input ?? '');
		const output = String(outputValues.output ?? '');
		await this.memory.saveContext(input, output);
	}

	async clear(): Promise<void> {
		await this.memory.clear();
	}
}
