/**
 * Code Workflow Builder
 *
 * Public entry point for the workflow generation system.
 *
 * Architecture:
 * Uses a unified CodeBuilderAgent that combines node discovery and code generation
 * in a single agentic loop, preserving full context throughout the process.
 */

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Logger } from '@n8n/backend-common';
import type { INodeTypeDescription } from 'n8n-workflow';

import { CodeBuilderAgent } from './code-builder-agent';
import type { EvaluationLogger } from './utils/evaluation-logger';
import type { StreamOutput } from './types/streaming';
import type { ChatPayload } from './workflow-builder-agent';

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
}

/**
 * Code Workflow Builder
 *
 * Generates n8n workflows using a unified CodeBuilderAgent that handles
 * both node discovery and code generation in a single pass.
 */
export class CodeWorkflowBuilder {
	private codeBuilderAgent: CodeBuilderAgent;
	private logger?: Logger;

	constructor(config: CodeWorkflowBuilderConfig) {
		this.codeBuilderAgent = new CodeBuilderAgent({
			llm: config.llm,
			nodeTypes: config.nodeTypes,
			logger: config.logger,
			generatedTypesDir: config.generatedTypesDir,
			evalLogger: config.evalLogger,
		});

		this.logger = config.logger;
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
		this.logger?.debug('CodeWorkflowBuilder starting', {
			userId,
			messageLength: payload.message.length,
		});

		// Delegate to CodeBuilderAgent
		yield* this.codeBuilderAgent.chat(payload, userId, abortSignal);
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
