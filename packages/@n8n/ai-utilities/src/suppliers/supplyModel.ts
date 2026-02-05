import { ChatOpenAI } from '@langchain/openai';
import type { ISupplyDataFunctions } from 'n8n-workflow';

import { LangchainAdapter } from '../adapters/langchain';
import type { ChatModel } from '../types/chat-model';
import type { OpenAIModelOptions } from '../types/openai';
import { makeN8nLlmFailedAttemptHandler } from '../utils/failed-attempt-handler/n8nLlmFailedAttemptHandler';
import { N8nLlmTracing } from '../utils/n8n-llm-tracing';

type OpenAiModel = OpenAIModelOptions & {
	type: 'openai';
};
type ModelOptions = ChatModel | OpenAiModel;

function isOpenAiModel(model: ModelOptions): model is OpenAiModel {
	return 'type' in model && model.type === 'openai';
}

export function supplyModel(ctx: ISupplyDataFunctions, model: ModelOptions) {
	if (isOpenAiModel(model)) {
		const openAiModel = new ChatOpenAI({
			model: model.model,
			apiKey: model.apiKey,
			useResponsesApi: model.useResponsesApi,
			logprobs: model.logprobs,
			topLogprobs: model.topLogprobs,
			supportsStrictToolCalling: model.supportsStrictToolCalling,
			reasoning: model.reasoning,
			zdrEnabled: model.zdrEnabled,
			service_tier: model.service_tier,
			promptCacheKey: model.promptCacheKey,
			temperature: model.temperature,
			topP: model.topP,
			frequencyPenalty: model.frequencyPenalty,
			presencePenalty: model.presencePenalty,
			stopSequences: model.stopSequences,
			maxRetries: model.maxRetries,
			modelKwargs: model.additionalParams,
			verbosity: model.verbosity,
			timeout: model.timeout,
			streaming: model.streaming,
			streamUsage: model.streamUsage,
			stop: model.stop,
			maxTokens: model.maxTokens,
			maxCompletionTokens: model.maxCompletionTokens,
			callbacks: [new N8nLlmTracing(ctx)],
			onFailedAttempt: makeN8nLlmFailedAttemptHandler(ctx, model.onFailedAttempt),
		});
		return {
			response: openAiModel,
		};
	}
	const adapter = new LangchainAdapter(model, ctx);
	return {
		response: adapter,
	};
}
