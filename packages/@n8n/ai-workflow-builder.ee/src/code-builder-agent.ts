/* eslint-disable complexity */
/**
 * Code Builder Agent
 *
 * Unified agent that generates complete workflows using TypeScript SDK format with an agentic loop
 * that handles tool calls for node discovery before producing the final workflow.
 *
 * This replaces the split Planning Agent + Coding Agent architecture by combining both
 * discovery and code generation in a single, context-preserving agent.
 */

import { inspect } from 'node:util';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Logger } from '@n8n/backend-common';
import type { INodeTypeDescription } from 'n8n-workflow';
import { parseWorkflowCodeToBuilder, validateWorkflow } from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import { extractWorkflowCode } from './utils/extract-code';
import { NodeTypeParser } from './utils/node-type-parser';
import { buildCodeBuilderPrompt } from './prompts/code-builder';
import { createCodeBuilderSearchTool } from './tools/code-builder-search.tool';
import { createCodeBuilderGetTool } from './tools/code-builder-get.tool';
import type {
	StreamOutput,
	AgentMessageChunk,
	WorkflowUpdateChunk,
	ToolProgressChunk,
	StreamGenerationError,
} from './types/streaming';
import type { ChatPayload } from './workflow-builder-agent';
import type { EvaluationLogger } from './utils/evaluation-logger';

/** Maximum iterations for the agentic loop to prevent infinite loops */
const MAX_AGENT_ITERATIONS = 25;

/** Claude Sonnet 4.5 pricing per million tokens (USD) */
const SONNET_4_5_PRICING = {
	inputPerMillion: 3,
	outputPerMillion: 15,
};

/**
 * Calculate cost estimate based on token usage
 */
function calculateCost(inputTokens: number, outputTokens: number): number {
	const inputCost = (inputTokens / 1_000_000) * SONNET_4_5_PRICING.inputPerMillion;
	const outputCost = (outputTokens / 1_000_000) * SONNET_4_5_PRICING.outputPerMillion;
	return inputCost + outputCost;
}

/**
 * Format duration in a human-readable way
 */
function formatDuration(ms: number): string {
	if (ms < 1000) {
		return `${ms}ms`;
	}
	const seconds = ms / 1000;
	if (seconds < 60) {
		return `${seconds.toFixed(1)}s`;
	}
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds.toFixed(0)}s`;
}

/**
 * Structured output type for the LLM response
 */
interface WorkflowCodeOutput {
	workflowCode: string;
}

/**
 * Result from parseAndValidate including workflow and any warnings
 */
interface ParseAndValidateResult {
	workflow: WorkflowJSON;
	warnings: Array<{ code: string; message: string; nodeName?: string }>;
}

/**
 * Configuration for the code builder agent
 */
export interface CodeBuilderAgentConfig {
	/** LLM for generation */
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
 * Code Builder Agent
 *
 * Generates workflows by:
 * 1. Building a comprehensive system prompt with workflow patterns
 * 2. Running an agentic loop that handles tool calls for node discovery
 * 3. Parsing the final TypeScript code to WorkflowJSON
 * 4. Validating and streaming the result
 */
export class CodeBuilderAgent {
	private llm: BaseChatModel;
	private nodeTypeParser: NodeTypeParser;
	private logger?: Logger;
	private evalLogger?: EvaluationLogger;
	private tools: StructuredToolInterface[];
	private toolsMap: Map<string, StructuredToolInterface>;

	constructor(config: CodeBuilderAgentConfig) {
		this.debugLog('CONSTRUCTOR', 'Initializing CodeBuilderAgent...', {
			nodeTypesCount: config.nodeTypes.length,
			hasLogger: !!config.logger,
		});
		this.llm = config.llm;
		this.nodeTypeParser = new NodeTypeParser(config.nodeTypes);
		this.logger = config.logger;
		this.evalLogger = config.evalLogger;

		// Create tools
		const searchTool = createCodeBuilderSearchTool(this.nodeTypeParser);
		const getTool = createCodeBuilderGetTool({ generatedTypesDir: config.generatedTypesDir });
		this.tools = [searchTool, getTool];
		this.toolsMap = new Map(this.tools.map((t) => [t.name, t]));

		this.debugLog('CONSTRUCTOR', 'CodeBuilderAgent initialized', {
			toolNames: this.tools.map((t) => t.name),
		});
	}

	/**
	 * Debug logging helper - logs to console with timestamp and prefix.
	 * Uses util.inspect for terminal-friendly output with full depth.
	 */
	private debugLog(context: string, message: string, data?: Record<string, unknown>): void {
		if (this.evalLogger) {
			this.evalLogger.log(`CODE-BUILDER:${context}`, message, data);
		} else {
			const timestamp = new Date().toISOString();
			const prefix = `[CODE-BUILDER][${timestamp}][${context}]`;

			if (data) {
				const formatted = inspect(data, {
					depth: null,
					colors: true,
					maxStringLength: null,
					maxArrayLength: null,
					breakLength: 120,
				});
				console.log(`${prefix} ${message}\n${formatted}`);
			} else {
				console.log(`${prefix} ${message}`);
			}
		}
	}

	/**
	 * Main chat method - generates workflow and streams output
	 * Implements an agentic loop that handles tool calls for node discovery
	 */
	async *chat(
		payload: ChatPayload,
		userId: string,
		abortSignal?: AbortSignal,
	): AsyncGenerator<StreamOutput, void, unknown> {
		const startTime = Date.now();
		this.debugLog('CHAT', '========== STARTING CHAT ==========');
		this.debugLog('CHAT', 'Input payload', {
			userId,
			messageLength: payload.message.length,
			message: payload.message,
			hasWorkflowContext: !!payload.workflowContext,
			hasCurrentWorkflow: !!payload.workflowContext?.currentWorkflow,
		});

		try {
			this.logger?.debug('Code builder agent starting', {
				userId,
				messageLength: payload.message.length,
			});

			// Build prompt with current workflow context if available
			this.debugLog('CHAT', 'Building prompt...');
			const currentWorkflow = payload.workflowContext?.currentWorkflow as WorkflowJSON | undefined;

			if (currentWorkflow) {
				this.debugLog('CHAT', 'Current workflow context provided', {
					workflowId: currentWorkflow.id,
					workflowName: currentWorkflow.name,
					nodeCount: currentWorkflow.nodes?.length ?? 0,
				});
			}

			const prompt = buildCodeBuilderPrompt(currentWorkflow);
			this.debugLog('CHAT', 'Prompt built successfully');

			// Bind tools to LLM
			this.debugLog('CHAT', 'Binding tools to LLM...');
			if (!this.llm.bindTools) {
				throw new Error('LLM does not support bindTools - cannot use tools for node discovery');
			}
			const llmWithTools = this.llm.bindTools(this.tools);
			this.debugLog('CHAT', 'Tools bound to LLM');

			// Format initial messages
			this.debugLog('CHAT', 'Formatting initial messages...');
			const formattedMessages = await prompt.formatMessages({ userMessage: payload.message });
			const messages: BaseMessage[] = [...formattedMessages];
			this.debugLog('CHAT', 'Initial messages formatted', {
				messageCount: messages.length,
			});

			// Run agentic loop
			this.debugLog('CHAT', 'Starting agentic loop...');
			let iteration = 0;
			let finalResult: WorkflowCodeOutput | null = null;
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let consecutiveParseErrors = 0;
			let workflow: WorkflowJSON | null = null;
			let parseDuration = 0;
			let sourceCode: string | null = null;
			const generationErrors: StreamGenerationError[] = [];
			// Track warning codes that have been sent to agent (to avoid repeating)
			const previousWarningCodes = new Set<string>();

			while (iteration < MAX_AGENT_ITERATIONS) {
				if (consecutiveParseErrors >= 3) {
					// Three consecutive parsing errors - fail
					this.debugLog('CHAT', 'Three consecutive parsing errors - failing');
					throw new Error('Failed to parse workflow code after 3 consecutive attempts.');
				}

				iteration++;
				this.debugLog('CHAT', `========== ITERATION ${iteration} ==========`);

				// Check for abort
				if (abortSignal?.aborted) {
					this.debugLog('CHAT', 'Abort signal received');
					throw new Error('Aborted');
				}

				// Invoke LLM
				this.debugLog('CHAT', 'Invoking LLM...');
				const llmStartTime = Date.now();
				const response = await llmWithTools.invoke(messages, { signal: abortSignal });
				const llmDuration = Date.now() - llmStartTime;
				// Extract token usage from response metadata
				const responseMetadata = response.response_metadata as
					| { usage?: { input_tokens?: number; output_tokens?: number } }
					| undefined;
				const inputTokens = responseMetadata?.usage?.input_tokens ?? 0;
				const outputTokens = responseMetadata?.usage?.output_tokens ?? 0;
				totalInputTokens += inputTokens;
				totalOutputTokens += outputTokens;

				this.debugLog('CHAT', 'LLM response received', {
					llmDurationMs: llmDuration,
					responseId: response.id,
					hasToolCalls: response.tool_calls && response.tool_calls.length > 0,
					toolCallCount: response.tool_calls?.length ?? 0,
					inputTokens,
					outputTokens,
					totalInputTokens,
					totalOutputTokens,
				});

				// Extract text content from response
				const textContent = this.extractTextContent(response);
				if (textContent) {
					this.debugLog('CHAT', 'Streaming text response', { textContent });
					yield {
						messages: [
							{
								role: 'assistant',
								type: 'message',
								text: textContent,
							} as AgentMessageChunk,
						],
					};
				}

				// Add AI message to history
				messages.push(response);

				// Check if there are tool calls
				if (response.tool_calls && response.tool_calls.length > 0) {
					this.debugLog('CHAT', 'Processing tool calls...', {
						toolCalls: response.tool_calls.map((tc) => ({
							name: tc.name,
							id: tc.id ?? 'unknown',
						})),
					});

					// Reset consecutive parse errors on tool calls (agent is doing other work)
					consecutiveParseErrors = 0;

					// Execute tool calls and stream progress
					for (const toolCall of response.tool_calls) {
						// Skip tool calls without an ID (shouldn't happen but handle gracefully)
						if (!toolCall.id) {
							this.debugLog('CHAT', 'Skipping tool call without ID', { name: toolCall.name });
							continue;
						}
						yield* this.executeToolCall(
							{ name: toolCall.name, args: toolCall.args, id: toolCall.id },
							messages,
						);
					}
				} else {
					// No tool calls - try to parse as final response
					this.debugLog('CHAT', 'No tool calls, attempting to parse final response...');
					const parseResult = this.parseStructuredOutput(response);
					finalResult = parseResult.result;

					if (finalResult) {
						this.debugLog('CHAT', 'Final result parsed successfully', {
							workflowCodeLength: finalResult.workflowCode.length,
						});

						// Try to parse and validate the workflow code
						this.debugLog('CHAT', 'Parsing and validating workflow code...');
						this.debugLog('CHAT', 'Raw workflow code from LLM:', {
							workflowCode: finalResult.workflowCode,
						});
						const parseStartTime = Date.now();

						try {
							const result = await this.parseAndValidate(finalResult.workflowCode, currentWorkflow);
							workflow = result.workflow;
							parseDuration = Date.now() - parseStartTime;
							sourceCode = finalResult.workflowCode; // Save for later use
							this.debugLog('CHAT', 'Workflow parsed and validated', {
								parseDurationMs: parseDuration,
								workflowId: workflow.id,
								workflowName: workflow.name,
								nodeCount: workflow.nodes.length,
								nodeTypes: workflow.nodes.map((n) => n.type),
								warningCount: result.warnings.length,
							});

							// Check for new warnings that haven't been sent to agent before
							const newWarnings = result.warnings.filter(
								(w) => !previousWarningCodes.has(`${w.code}:${w.message}`),
							);

							if (newWarnings.length > 0) {
								this.debugLog('CHAT', 'New validation warnings found', {
									newWarningCount: newWarnings.length,
									newWarningCodes: newWarnings.map((w) => w.code),
								});

								// Mark these warnings as sent (so we don't repeat)
								for (const w of newWarnings) {
									previousWarningCodes.add(`${w.code}:${w.message}`);
								}

								// Format warnings for the agent
								const warningMessages = newWarnings
									.slice(0, 5) // Limit to first 5 warnings
									.map((w) => `- [${w.code}] ${w.message}`)
									.join('\n');

								// Track as generation error for artifacts
								generationErrors.push({
									message: `Validation warnings:\n${warningMessages}`,
									code: finalResult.workflowCode,
									iteration,
									type: 'validation',
								});

								// Log warnings with console.warn for visibility
								this.evalLogger?.logWarnings('CODE-BUILDER:VALIDATION', newWarnings);

								// Send warnings back to agent for one correction attempt
								messages.push(
									new HumanMessage(
										`The workflow code has validation warnings that should be addressed:\n\n${warningMessages}\n\nPlease fix these issues and provide the corrected version in a \`\`\`typescript code block.`,
									),
								);
								workflow = null; // Reset so we continue the loop
								finalResult = null;
								continue;
							}

							// No new warnings (or all are repeats) - successfully parsed, exit the loop
							this.debugLog('CHAT', 'No new warnings, accepting workflow');
							break;
						} catch (parseError) {
							parseDuration = Date.now() - parseStartTime;
							consecutiveParseErrors++;
							const errorMessage =
								parseError instanceof Error ? parseError.message : String(parseError);
							const errorStack = parseError instanceof Error ? parseError.stack : undefined;

							// Track the generation error
							generationErrors.push({
								message: errorMessage,
								code: finalResult?.workflowCode,
								iteration,
								type: 'parse',
							});

							this.debugLog('CHAT', 'Workflow parsing failed', {
								parseDurationMs: parseDuration,
								consecutiveParseErrors,
								errorMessage,
							});

							// Log error with console.error for visibility
							this.evalLogger?.logError(
								'CODE-BUILDER:PARSE',
								errorMessage,
								finalResult?.workflowCode,
								errorStack,
							);

							// First parsing error - send error back to agent for correction
							this.debugLog(
								'CHAT',
								'First parsing error - sending error back to agent for correction',
							);
							messages.push(
								new HumanMessage(
									`The workflow code you generated has a parsing error:\n\n${errorMessage}\n\nPlease fix the code and provide the corrected version in a \`\`\`typescript code block.`,
								),
							);
							finalResult = null; // Reset so we can try again
						}
					} else {
						consecutiveParseErrors++;
						this.debugLog(
							'CHAT',
							'Could not parse structured output, continuing loop for another response...',
							{ parseError: parseResult.error },
						);
						// Add a follow-up message with the error to help the LLM correct its response
						messages.push(
							new HumanMessage(
								`Could not parse your response: ${parseResult.error}\n\nPlease provide your workflow code in a \`\`\`typescript code block.`,
							),
						);
					}
				}
			}

			if (!workflow) {
				throw new Error(
					`Failed to generate workflow after ${MAX_AGENT_ITERATIONS} iterations. The agent may be stuck in a tool-calling loop.`,
				);
			}

			const llmDuration = Date.now() - startTime;
			this.debugLog('CHAT', 'Agentic loop complete', {
				iterations: iteration,
				totalLlmDurationMs: llmDuration,
			});

			// Log success
			this.logger?.info('Code builder agent generated workflow', {
				userId,
				nodeCount: workflow.nodes.length,
				iterations: iteration,
			});

			// Calculate stats
			const totalDuration = Date.now() - startTime;
			const totalTokens = totalInputTokens + totalOutputTokens;
			const estimatedCost = calculateCost(totalInputTokens, totalOutputTokens);

			this.debugLog('CHAT', 'Request stats', {
				totalDurationMs: totalDuration,
				totalInputTokens,
				totalOutputTokens,
				totalTokens,
				estimatedCostUsd: estimatedCost,
			});

			// Stream stats message
			const statsMessage = `Generated workflow in ${formatDuration(totalDuration)} | ${totalTokens.toLocaleString()} tokens (${totalInputTokens.toLocaleString()} in, ${totalOutputTokens.toLocaleString()} out) | Est. cost: $${estimatedCost.toFixed(4)}`;
			yield {
				messages: [
					{
						role: 'assistant',
						type: 'message',
						text: statsMessage,
					} as AgentMessageChunk,
				],
			};

			// Stream workflow update (includes source code for evaluation artifacts)
			this.debugLog('CHAT', 'Streaming workflow update');
			yield {
				messages: [
					{
						role: 'assistant',
						type: 'workflow-updated',
						codeSnippet: JSON.stringify(workflow, null, 2),
						sourceCode: sourceCode ?? '',
						tokenUsage: {
							inputTokens: totalInputTokens,
							outputTokens: totalOutputTokens,
						},
						iterationCount: iteration,
						generationErrors: generationErrors.length > 0 ? generationErrors : undefined,
					} as WorkflowUpdateChunk,
				],
			};

			this.debugLog('CHAT', '========== CHAT COMPLETE ==========', {
				totalDurationMs: totalDuration,
				totalInputTokens,
				totalOutputTokens,
				estimatedCostUsd: estimatedCost,
				parseDurationMs: parseDuration,
				nodeCount: workflow.nodes.length,
				iterations: iteration,
			});
		} catch (error) {
			const totalDuration = Date.now() - startTime;
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;

			this.debugLog('CHAT', '========== CHAT FAILED ==========', {
				totalDurationMs: totalDuration,
				errorMessage,
			});

			// Log error with console.error for visibility
			this.evalLogger?.logError('CODE-BUILDER:FATAL', errorMessage, undefined, errorStack);

			this.logger?.error('Code builder agent failed', {
				userId,
				error: errorMessage,
			});

			// Stream error message
			yield {
				messages: [
					{
						role: 'assistant',
						type: 'message',
						text: `I encountered an error while generating the workflow: ${errorMessage}. Please try rephrasing your request.`,
					} as AgentMessageChunk,
				],
			};
		}
	}

	/**
	 * Extract text content from an AI message
	 */
	private extractTextContent(message: AIMessage): string | null {
		// Content can be a string or an array of content blocks
		if (typeof message.content === 'string') {
			return message.content || null;
		}

		if (Array.isArray(message.content)) {
			const textParts = message.content
				.filter(
					(block): block is { type: 'text'; text: string } =>
						typeof block === 'object' && block !== null && 'type' in block && block.type === 'text',
				)
				.map((block) => block.text);

			return textParts.length > 0 ? textParts.join('\n') : null;
		}

		return null;
	}

	/**
	 * Execute a tool call and yield progress updates
	 */
	private async *executeToolCall(
		toolCall: { name: string; args: Record<string, unknown>; id: string },
		messages: BaseMessage[],
	): AsyncGenerator<StreamOutput, void, unknown> {
		this.debugLog('TOOL_CALL', `Executing tool: ${toolCall.name}`, {
			toolCallId: toolCall.id,
			args: toolCall.args,
		});

		// Stream tool progress
		yield {
			messages: [
				{
					type: 'tool',
					toolName: toolCall.name,
					status: 'running',
					args: toolCall.args,
				} as ToolProgressChunk,
			],
		};

		const tool = this.toolsMap.get(toolCall.name);
		if (!tool) {
			const errorMessage = `Tool '${toolCall.name}' not found`;
			this.debugLog('TOOL_CALL', errorMessage);
			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id,
					content: errorMessage,
				}),
			);
			return;
		}

		try {
			const toolStartTime = Date.now();
			const result = await tool.invoke(toolCall.args);
			const toolDuration = Date.now() - toolStartTime;

			// Serialize result for logging and message
			const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

			this.debugLog('TOOL_CALL', `Tool ${toolCall.name} completed`, {
				toolDurationMs: toolDuration,
				resultLength: resultStr.length,
				result: resultStr,
			});

			// Log full tool output to evaluation logger
			this.evalLogger?.logToolCall(toolCall.name, toolCall.args, resultStr, toolDuration);

			// Add tool result to messages
			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id,
					content: resultStr,
				}),
			);

			// Stream tool completion
			yield {
				messages: [
					{
						type: 'tool',
						toolName: toolCall.name,
						status: 'completed',
					} as ToolProgressChunk,
				],
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			this.debugLog('TOOL_CALL', `Tool ${toolCall.name} failed`, { error: errorMessage });

			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id,
					content: `Error: ${errorMessage}`,
				}),
			);

			yield {
				messages: [
					{
						type: 'tool',
						toolName: toolCall.name,
						status: 'error',
						error: errorMessage,
					} as ToolProgressChunk,
				],
			};
		}
	}

	/**
	 * Parse structured output from an AI message
	 * Extracts workflow code from TypeScript code blocks
	 * Returns object with result or error information
	 */
	private parseStructuredOutput(message: AIMessage): {
		result: WorkflowCodeOutput | null;
		error: string | null;
	} {
		const content = this.extractTextContent(message);
		if (!content) {
			this.debugLog('PARSE_OUTPUT', 'No text content to parse');
			return { result: null, error: 'No text content found in response' };
		}

		this.debugLog('PARSE_OUTPUT', 'Attempting to extract workflow code', {
			contentLength: content.length,
			contentPreview: content.substring(0, 500),
		});

		// Extract code from TypeScript code blocks
		const workflowCode = extractWorkflowCode(content);

		// Check if we got valid code (should contain workflow-related keywords)
		if (!workflowCode || !workflowCode.includes('workflow')) {
			this.debugLog('PARSE_OUTPUT', 'No valid workflow code found in content');
			return {
				result: null,
				error:
					'No valid workflow code found in response. Please provide your code in a ```typescript code block.',
			};
		}

		this.debugLog('PARSE_OUTPUT', 'Successfully extracted workflow code', {
			workflowCodeLength: workflowCode.length,
		});

		return { result: { workflowCode }, error: null };
	}

	/**
	 * Parse TypeScript code to WorkflowJSON and validate
	 * Returns both the workflow and any validation warnings
	 */
	private async parseAndValidate(
		code: string,
		currentWorkflow?: WorkflowJSON,
	): Promise<ParseAndValidateResult> {
		this.debugLog('PARSE_VALIDATE', '========== PARSING WORKFLOW CODE ==========');
		this.debugLog('PARSE_VALIDATE', 'Input code', {
			codeLength: code.length,
			codePreview: code.substring(0, 500),
			codeEnd: code.substring(Math.max(0, code.length - 500)),
		});

		try {
			// Parse the TypeScript code to WorkflowBuilder
			this.logger?.debug('Parsing WorkflowCode', { codeLength: code.length });
			this.debugLog('PARSE_VALIDATE', 'Calling parseWorkflowCodeToBuilder...');
			const parseStartTime = Date.now();
			const builder = parseWorkflowCodeToBuilder(code);
			const parseDuration = Date.now() - parseStartTime;

			this.debugLog('PARSE_VALIDATE', 'Code parsed to builder', {
				parseDurationMs: parseDuration,
			});

			// Validate the graph structure BEFORE converting to JSON
			this.debugLog('PARSE_VALIDATE', 'Validating graph structure...');
			const graphValidateStartTime = Date.now();
			const graphValidation = builder.validate();
			const graphValidateDuration = Date.now() - graphValidateStartTime;

			this.debugLog('PARSE_VALIDATE', 'Graph validation complete', {
				validateDurationMs: graphValidateDuration,
				isValid: graphValidation.valid,
				errorCount: graphValidation.errors.length,
				warningCount: graphValidation.warnings.length,
			});

			// If there are graph validation errors, throw to trigger self-correction
			if (graphValidation.errors.length > 0) {
				const errorMessages = graphValidation.errors
					.map((e: { message: string; code?: string }) => `[${e.code}] ${e.message}`)
					.join('\n');
				this.debugLog('PARSE_VALIDATE', 'GRAPH VALIDATION ERRORS', {
					errors: graphValidation.errors.map((e: { message: string; code?: string }) => ({
						message: e.message,
						code: e.code,
					})),
				});
				throw new Error(`Graph validation errors:\n${errorMessages}`);
			}

			// Collect all warnings (graph validation)
			const allWarnings: Array<{ code: string; message: string; nodeName?: string }> = [];

			// Log warnings (but don't fail on them)
			if (graphValidation.warnings.length > 0) {
				this.debugLog('PARSE_VALIDATE', 'GRAPH VALIDATION WARNINGS', {
					warnings: graphValidation.warnings.map((w: { message: string; code?: string }) => ({
						message: w.message,
						code: w.code,
					})),
				});
				this.logger?.info('Graph validation warnings', {
					warnings: graphValidation.warnings.map((w: { message: string }) => w.message),
				});
				// Add to all warnings
				for (const w of graphValidation.warnings) {
					allWarnings.push({
						code: w.code,
						message: w.message,
						nodeName: w.nodeName,
					});
				}
			}

			// Generate pin data for new nodes only (nodes not in currentWorkflow)
			builder.generatePinData({ beforeWorkflow: currentWorkflow });

			// Convert to JSON
			this.debugLog('PARSE_VALIDATE', 'Converting to JSON...');
			const workflow: WorkflowJSON = builder.toJSON();

			this.debugLog('PARSE_VALIDATE', 'Workflow converted to JSON', {
				workflowId: workflow.id,
				workflowName: workflow.name,
				nodeCount: workflow.nodes.length,
				connectionCount: Object.keys(workflow.connections).length,
			});

			// Log each node
			this.debugLog('PARSE_VALIDATE', 'Parsed nodes', {
				nodes: workflow.nodes.map((n) => ({
					id: n.id,
					name: n.name,
					type: n.type,
					position: n.position,
					parametersKeys: n.parameters ? Object.keys(n.parameters) : [],
				})),
			});

			// Log connections
			this.debugLog('PARSE_VALIDATE', 'Parsed connections', {
				connections: workflow.connections,
			});

			this.logger?.debug('Parsed workflow', {
				id: workflow.id,
				name: workflow.name,
				nodeCount: workflow.nodes.length,
			});

			// Also run JSON-based validation for additional checks
			this.debugLog('PARSE_VALIDATE', 'Running JSON validation...');
			const validateStartTime = Date.now();
			const validationResult = validateWorkflow(workflow);
			const validateDuration = Date.now() - validateStartTime;

			this.debugLog('PARSE_VALIDATE', 'JSON validation complete', {
				validateDurationMs: validateDuration,
				isValid: validationResult.valid,
				errorCount: validationResult.errors.length,
				warningCount: validationResult.warnings.length,
			});

			if (validationResult.errors.length > 0) {
				this.debugLog('PARSE_VALIDATE', 'JSON VALIDATION ERRORS', {
					errors: validationResult.errors.map((e: { message: string; code?: string }) => ({
						message: e.message,
						code: e.code,
					})),
				});
				this.logger?.warn('Workflow validation errors', {
					errors: validationResult.errors.map((e: { message: string }) => e.message),
				});
			}

			if (validationResult.warnings.length > 0) {
				this.debugLog('PARSE_VALIDATE', 'JSON VALIDATION WARNINGS', {
					warnings: validationResult.warnings.map((w: { message: string; code?: string }) => ({
						message: w.message,
						code: w.code,
					})),
				});
				this.logger?.info('Workflow validation warnings', {
					warnings: validationResult.warnings.map((w: { message: string }) => w.message),
				});
				// Add JSON validation warnings to allWarnings for agent self-correction
				for (const w of validationResult.warnings) {
					allWarnings.push({
						code: w.code,
						message: w.message,
						nodeName: w.nodeName,
					});
				}
			}

			// Log full workflow JSON
			this.debugLog('PARSE_VALIDATE', 'Final workflow JSON', {
				workflow: JSON.stringify(workflow, null, 2),
			});

			this.debugLog('PARSE_VALIDATE', '========== PARSING COMPLETE ==========');

			// Return both workflow and warnings for agent self-correction
			return { workflow, warnings: allWarnings };
		} catch (error) {
			this.debugLog('PARSE_VALIDATE', '========== PARSING FAILED ==========', {
				errorMessage: error instanceof Error ? error.message : String(error),
				errorStack: error instanceof Error ? error.stack : undefined,
				code,
			});

			this.logger?.error('Failed to parse WorkflowCode', {
				error: error instanceof Error ? error.message : String(error),
				code: code.substring(0, 500), // Log first 500 chars
			});

			// Retry once with error feedback
			throw new Error(
				`Failed to parse generated workflow code: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
		}
	}
}
