import type { ISupplyDataFunctions } from 'n8n-workflow';

import { supplyModel } from './supplyModel';

const mockLangchainAdapterInstance = { __brand: 'LangchainAdapter' };

jest.mock('@langchain/openai', () => ({
	ChatOpenAI: jest.fn().mockImplementation(function (this: any) {
		// Return a new object each time so metadata can be set independently
		return { __brand: 'ChatOpenAI', metadata: {} };
	}),
}));

jest.mock('../utils/http-proxy-agent', () => ({
	getProxyAgent: jest.fn().mockReturnValue({ __agent: true }),
}));

jest.mock('../utils/n8n-llm-tracing', () => ({
	N8nLlmTracing: jest.fn().mockImplementation(function (this: unknown) {
		return this;
	}),
}));

jest.mock('../utils/failed-attempt-handler/n8nLlmFailedAttemptHandler', () => ({
	makeN8nLlmFailedAttemptHandler: jest.fn().mockReturnValue(jest.fn()),
}));

jest.mock('../adapters/langchain-chat-model', () => ({
	LangchainAdapter: jest.fn().mockImplementation(() => mockLangchainAdapterInstance),
}));

const { ChatOpenAI } = jest.requireMock('@langchain/openai');
const { LangchainAdapter } = jest.requireMock('../adapters/langchain-chat-model');

describe('supplyModel', () => {
	const mockCtx = {
		getNode: jest.fn(),
		addOutputData: jest.fn(),
		addInputData: jest.fn(),
		getNextRunIndex: jest.fn(),
	} as unknown as ISupplyDataFunctions;

	beforeEach(() => {
		jest.clearAllMocks();
	});

	describe('OpenAI model path', () => {
		it('returns response from ChatOpenAI when model has type "openai"', () => {
			const openAiModel = {
				type: 'openai' as const,
				baseUrl: 'https://api.openai.com',
				model: 'gpt-4',
				apiKey: 'test-key',
			};

			const result = supplyModel(mockCtx, openAiModel);

			expect(result.response).toEqual(
				expect.objectContaining({
					__brand: 'ChatOpenAI',
					metadata: {},
				}),
			);
			expect(ChatOpenAI).toHaveBeenCalledTimes(1);
			expect(LangchainAdapter).not.toHaveBeenCalled();
		});

		it('passes ctx and OpenAI options to ChatOpenAI when model has defaultHeaders and timeout', () => {
			const openAiModel = {
				type: 'openai' as const,
				baseUrl: 'https://api.example.com',
				model: 'gpt-4',
				apiKey: 'key',
				defaultHeaders: { 'X-Custom': 'value' },
				timeout: 60_000,
			};

			supplyModel(mockCtx, openAiModel);

			expect(ChatOpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					model: 'gpt-4',
					apiKey: 'key',
					configuration: expect.objectContaining({
						baseURL: 'https://api.example.com',
						defaultHeaders: { 'X-Custom': 'value' },
					}),
				}),
			);
		});

		it('includes providerTools in metadata when model has providerTools', () => {
			const result = supplyModel(mockCtx, {
				type: 'openai' as const,
				baseUrl: 'https://api.openai.com',
				model: 'gpt-4',
				apiKey: 'key',
				providerTools: [{ type: 'provider', name: 'web_search', args: { size: 'medium' } }],
			});

			expect(ChatOpenAI).toHaveBeenCalledWith(
				expect.objectContaining({
					model: 'gpt-4',
					apiKey: 'key',
				}),
			);

			// Verify that the returned model has the correct metadata with providerTools
			// The providerTools should be mapped to metadata.tools format
			expect((result.response as any).metadata).toEqual({
				tools: [
					{
						type: 'web_search',
						size: 'medium',
					},
				],
			});
		});

		it('maps multiple providerTools correctly in metadata', () => {
			const result = supplyModel(mockCtx, {
				type: 'openai' as const,
				baseUrl: 'https://api.openai.com',
				model: 'gpt-4',
				apiKey: 'key',
				providerTools: [
					{ type: 'provider', name: 'web_search', args: { engine: 'google', limit: 10 } },
					{ type: 'provider', name: 'code_interpreter', args: { timeout: 30 } },
				],
			});

			// Verify that all providerTools are correctly mapped to metadata.tools
			expect((result.response as any).metadata.tools).toHaveLength(2);
			expect((result.response as any).metadata.tools[0]).toEqual({
				type: 'web_search',
				engine: 'google',
				limit: 10,
			});
			expect((result.response as any).metadata.tools[1]).toEqual({
				type: 'code_interpreter',
				timeout: 30,
			});
		});

		it('does not set metadata.tools when providerTools is empty', () => {
			const result = supplyModel(mockCtx, {
				type: 'openai' as const,
				baseUrl: 'https://api.openai.com',
				model: 'gpt-4',
				apiKey: 'key',
				providerTools: [],
			});

			// Empty providerTools should not set metadata.tools
			expect((result.response as any).metadata).toEqual({});
		});
	});

	describe('ChatModel (LangchainAdapter) path', () => {
		it('returns response from LangchainAdapter when model does not have type "openai"', () => {
			const chatModel = {
				provider: 'anthropic',
				modelId: 'claude-3',
				generate: jest.fn(),
				stream: jest.fn(),
				withTools: jest.fn().mockReturnThis(),
			};

			const result = supplyModel(mockCtx, chatModel);

			expect(result).toEqual({ response: mockLangchainAdapterInstance });
			expect(LangchainAdapter).toHaveBeenCalledTimes(1);
			expect(LangchainAdapter).toHaveBeenCalledWith(chatModel, mockCtx);
			expect(ChatOpenAI).not.toHaveBeenCalled();
		});

		it('uses LangchainAdapter when model has type other than "openai"', () => {
			const modelWithOtherType = {
				type: 'custom',
				provider: 'custom',
				modelId: 'custom-model',
				generate: jest.fn(),
				stream: jest.fn(),
				withTools: jest.fn().mockReturnThis(),
			};

			const result = supplyModel(mockCtx, modelWithOtherType);

			expect(result).toEqual({ response: mockLangchainAdapterInstance });
			expect(LangchainAdapter).toHaveBeenCalledWith(modelWithOtherType, mockCtx);
			expect(ChatOpenAI).not.toHaveBeenCalled();
		});

		it('uses LangchainAdapter when model has no type property', () => {
			const modelWithoutType = {
				provider: 'google',
				modelId: 'gemini-pro',
				generate: jest.fn(),
				stream: jest.fn(),
				withTools: jest.fn().mockReturnThis(),
			};

			const result = supplyModel(mockCtx, modelWithoutType);

			expect(result).toEqual({ response: mockLangchainAdapterInstance });
			expect(LangchainAdapter).toHaveBeenCalledWith(modelWithoutType, mockCtx);
			expect(ChatOpenAI).not.toHaveBeenCalled();
		});
	});
});
