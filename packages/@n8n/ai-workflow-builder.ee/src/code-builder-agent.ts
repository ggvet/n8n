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

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Logger } from '@n8n/backend-common';
import {
	parseWorkflowCodeToBuilder,
	validateWorkflow,
	generateWorkflowCode,
} from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';
import type { INodeTypeDescription } from 'n8n-workflow';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import { buildCodeBuilderPrompt, type HistoryContext } from './prompts/code-builder';
import { createCodeBuilderGetTool } from './tools/code-builder-get.tool';
import { createCodeBuilderSearchTool } from './tools/code-builder-search.tool';
import { createGetSuggestedNodesTool } from './tools/get-suggested-nodes.tool';
import { TextEditorHandler } from './tools/text-editor-handler';
import type {
	StreamOutput,
	AgentMessageChunk,
	WorkflowUpdateChunk,
	ToolProgressChunk,
	StreamGenerationError,
} from './types/streaming';
import type { TextEditorCommand } from './types/text-editor';
import type { EvaluationLogger } from './utils/evaluation-logger';
import {
	extractWorkflowCode,
	SDK_IMPORT_STATEMENT,
	stripImportStatements,
} from './utils/extract-code';
import { NodeTypeParser } from './utils/node-type-parser';
import type { ChatPayload } from './workflow-builder-agent';

/** Maximum iterations for the agentic loop to prevent infinite loops */
const MAX_AGENT_ITERATIONS = 25;

/** Maximum validate attempts before giving up in text editor mode */
const MAX_VALIDATE_ATTEMPTS = 10;

/** Native Anthropic text editor tool configuration */
const TEXT_EDITOR_TOOL = {
	type: 'text_editor_20250728' as const,
	name: 'str_replace_based_edit_tool' as const,
};

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
	/**
	 * Enable the text editor tool for targeted code edits.
	 * If not specified, auto-enabled for Claude 4.x models.
	 */
	enableTextEditor?: boolean;
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
	private enableTextEditorConfig?: boolean;
	/** Current session log file path (for temporary file-based logging) */
	private currentLogFile: string | null = null;

	constructor(config: CodeBuilderAgentConfig) {
		this.debugLog('CONSTRUCTOR', 'Initializing CodeBuilderAgent...', {
			nodeTypesCount: config.nodeTypes.length,
			hasLogger: !!config.logger,
		});
		this.llm = config.llm;
		this.nodeTypeParser = new NodeTypeParser(config.nodeTypes);
		this.logger = config.logger;
		this.evalLogger = config.evalLogger;
		this.enableTextEditorConfig = config.enableTextEditor;

		// Create tools
		const searchTool = createCodeBuilderSearchTool(this.nodeTypeParser);
		const getTool = createCodeBuilderGetTool({ generatedTypesDir: config.generatedTypesDir });
		const suggestedNodesTool = createGetSuggestedNodesTool(this.nodeTypeParser);
		this.tools = [searchTool, getTool, suggestedNodesTool];
		this.toolsMap = new Map(this.tools.map((t) => [t.name, t]));

		this.debugLog('CONSTRUCTOR', 'CodeBuilderAgent initialized', {
			toolNames: this.tools.map((t) => t.name),
		});
	}

	/**
	 * Initialize a log file for the current chat session.
	 * Creates a file with timestamp, workflow ID, and prompt snippet in the name.
	 */
	private initLogFile(workflowId: string | undefined, prompt: string): void {
		const logDir = join(tmpdir(), 'n8n-code-builder-logs');
		if (!existsSync(logDir)) {
			mkdirSync(logDir, { recursive: true });
		}

		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		const id = workflowId ?? `session-${Date.now()}`;
		// Sanitize prompt for filename: take first 30 chars, replace non-alphanumeric with dash
		const promptSnippet = prompt
			.substring(0, 30)
			.replace(/[^a-zA-Z0-9]/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			.toLowerCase();

		const filename = `${timestamp}_${id}_${promptSnippet}.log`;
		this.currentLogFile = join(logDir, filename);

		// Write header to log file
		const header = `=== Code Builder Agent Log ===
Timestamp: ${new Date().toISOString()}
Workflow ID: ${workflowId ?? 'N/A'}
Prompt: ${prompt}
Log File: ${this.currentLogFile}
${'='.repeat(50)}

`;
		appendFileSync(this.currentLogFile, header);
		console.log(`[CODE-BUILDER] Log file created: ${this.currentLogFile}`);
	}

	/**
	 * Debug logging helper - logs to console with timestamp and prefix.
	 * Also writes to file if a log file is initialized.
	 * Uses util.inspect for terminal-friendly output with full depth.
	 */
	private debugLog(context: string, message: string, data?: Record<string, unknown>): void {
		const timestamp = new Date().toISOString();
		const prefix = `[CODE-BUILDER][${timestamp}][${context}]`;

		// Format the log entry
		let logEntry: string;
		if (data) {
			const formatted = inspect(data, {
				depth: null,
				colors: false, // No colors for file output
				maxStringLength: null,
				maxArrayLength: null,
				breakLength: 120,
			});
			logEntry = `${prefix} ${message}\n${formatted}\n`;
		} else {
			logEntry = `${prefix} ${message}\n`;
		}

		// Write to file if initialized
		if (this.currentLogFile) {
			try {
				appendFileSync(this.currentLogFile, logEntry);
			} catch {
				// Silently ignore file write errors
			}
		}

		// Also log to eval logger or console
		if (this.evalLogger) {
			this.evalLogger.log(`CODE-BUILDER:${context}`, message, data);
		} else {
			// Console version with colors
			if (data) {
				const coloredFormatted = inspect(data, {
					depth: null,
					colors: true,
					maxStringLength: null,
					maxArrayLength: null,
					breakLength: 120,
				});
				console.log(`${prefix} ${message}\n${coloredFormatted}`);
			} else {
				console.log(`${prefix} ${message}`);
			}
		}
	}

	/**
	 * Determine whether to enable the text editor tool.
	 * Auto-enables for Claude 4.x models if not explicitly configured.
	 */
	private shouldEnableTextEditor(): boolean {
		if (this.enableTextEditorConfig !== undefined) {
			return this.enableTextEditorConfig;
		}
		// Auto-enable for Claude 4.x models (check model name from LLM)
		const modelName = (this.llm as { modelId?: string }).modelId ?? '';
		return (
			modelName.includes('claude-4') ||
			modelName.includes('opus-4') ||
			modelName.includes('sonnet-4')
		);
	}

	/**
	 * Extract error context with line numbers for debugging
	 */
	private getErrorContext(code: string, errorMessage: string): string {
		// Try to extract line number from error message (e.g., "at line 5" or "Line 5:")
		const lineMatch = errorMessage.match(/(?:line|Line)\s*(\d+)/i);
		if (!lineMatch) {
			// No line number - show first 10 lines as context
			const lines = code.split('\n').slice(0, 10);
			return `Code context:\n${lines.map((l, i) => `${i + 1}: ${l}`).join('\n')}`;
		}

		const errorLine = parseInt(lineMatch[1], 10);
		const lines = code.split('\n');

		// Show 3 lines before and after the error line
		const start = Math.max(0, errorLine - 4);
		const end = Math.min(lines.length, errorLine + 3);
		const context = lines
			.slice(start, end)
			.map((l, i) => {
				const lineNum = start + i + 1;
				const marker = lineNum === errorLine ? '> ' : '  ';
				return `${marker}${lineNum}: ${l}`;
			})
			.join('\n');

		return `Code around line ${errorLine}:\n${context}`;
	}

	/**
	 * Main chat method - generates workflow and streams output
	 * Implements an agentic loop that handles tool calls for node discovery
	 *
	 * @param payload - Chat payload with message and workflow context
	 * @param userId - User ID for logging
	 * @param abortSignal - Optional abort signal
	 * @param historyContext - Optional conversation history for multi-turn refinement
	 */
	async *chat(
		payload: ChatPayload,
		userId: string,
		abortSignal?: AbortSignal,
		historyContext?: HistoryContext,
	): AsyncGenerator<StreamOutput, void, unknown> {
		const startTime = Date.now();

		// Initialize log file for this session
		const workflowId = (payload.workflowContext?.currentWorkflow as WorkflowJSON | undefined)?.id;
		this.initLogFile(workflowId, payload.message);

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

			// Check if text editor mode should be enabled
			const textEditorEnabled = this.shouldEnableTextEditor();
			this.debugLog('CHAT', 'Text editor mode', { textEditorEnabled });

			const prompt = buildCodeBuilderPrompt(currentWorkflow, historyContext, {
				enableTextEditor: textEditorEnabled,
			});
			this.debugLog('CHAT', 'Prompt built successfully', {
				hasHistoryContext: !!historyContext,
				historyMessagesCount: historyContext?.userMessages?.length ?? 0,
				hasPreviousSummary: !!historyContext?.previousSummary,
				textEditorEnabled,
			});

			// Bind tools to LLM (include text editor tool when enabled)
			this.debugLog('CHAT', 'Binding tools to LLM...');
			if (!this.llm.bindTools) {
				throw new Error('LLM does not support bindTools - cannot use tools for node discovery');
			}
			const toolsToUse = textEditorEnabled ? [...this.tools, TEXT_EDITOR_TOOL] : this.tools;
			const llmWithTools = this.llm.bindTools(toolsToUse);
			this.debugLog('CHAT', 'Tools bound to LLM', {
				toolCount: toolsToUse.length,
				includesTextEditor: textEditorEnabled,
			});

			// Format initial messages
			this.debugLog('CHAT', 'Formatting initial messages...');
			const formattedMessages = await prompt.formatMessages({ userMessage: payload.message });
			const messages: BaseMessage[] = [...formattedMessages];

			// Log the actual prompt content for debugging
			this.debugLog('CHAT', 'Initial messages formatted', {
				messageCount: messages.length,
			});
			for (let i = 0; i < formattedMessages.length; i++) {
				const msg = formattedMessages[i];
				const msgType = msg._getType();
				const content =
					typeof msg.content === 'string'
						? msg.content
						: JSON.stringify(msg.content).substring(0, 2000);
				this.debugLog('CHAT', `Message ${i + 1} (${msgType})`, {
					contentLength: typeof msg.content === 'string' ? msg.content.length : 0,
					contentPreview: content.substring(0, 1000),
				});
			}

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

			// Text editor mode state
			let textEditorHandler: TextEditorHandler | null = null;
			let textEditorValidateAttempts = 0;

			if (textEditorEnabled) {
				// Pass debug log function to handler for detailed logging
				textEditorHandler = new TextEditorHandler((context, message, data) => {
					this.debugLog(`TEXT_EDITOR_HANDLER:${context}`, message, data);
				});

				// Always pre-populate with current workflow code (even for empty workflows)
				// This ensures the LLM uses str_replace instead of create command
				// Prepend SDK import so LLM sees available functions
				if (currentWorkflow) {
					const existingCode = generateWorkflowCode(currentWorkflow);
					const codeWithImport = `${SDK_IMPORT_STATEMENT}\n\n${existingCode}`;
					textEditorHandler.setWorkflowCode(codeWithImport);
					this.debugLog('CHAT', 'Pre-populated text editor with workflow code', {
						codeLength: codeWithImport.length,
					});
				}
			}

			while (iteration < MAX_AGENT_ITERATIONS) {
				if (consecutiveParseErrors >= 3) {
					// Three consecutive parsing errors - fail
					this.debugLog('CHAT', 'Three consecutive parsing errors - failing');
					throw new Error('Failed to parse workflow code after 3 consecutive attempts.');
				}

				iteration++;
				this.debugLog('CHAT', `========== ITERATION ${iteration} ==========`);

				// Log message history state at start of iteration
				this.debugLog('CHAT', 'Message history state', {
					messageCount: messages.length,
					messageTypes: messages.map((m) => m._getType()),
					lastMessageType: messages[messages.length - 1]?._getType(),
					consecutiveParseErrors,
					textEditorValidateAttempts,
				});

				// Check for abort
				if (abortSignal?.aborted) {
					this.debugLog('CHAT', 'Abort signal received');
					throw new Error('Aborted');
				}

				// Invoke LLM
				this.debugLog('CHAT', 'Invoking LLM with message history...');
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

				// Log full response content including thinking blocks
				this.debugLog('CHAT', 'Full LLM response content', {
					contentType: typeof response.content,
					contentIsArray: Array.isArray(response.content),
					rawContent: response.content,
				});

				// Extract and log thinking/planning content separately if present
				const thinkingContent = this.extractThinkingContent(response);
				if (thinkingContent) {
					this.debugLog('CHAT', '========== AGENT THINKING/PLANNING ==========', {
						thinkingContent,
					});
				}

				// Extract text content from response
				const textContent = this.extractTextContent(response);
				if (textContent) {
					this.debugLog('CHAT', 'Streaming text response', {
						textContentLength: textContent.length,
						textContent,
					});
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

						// Handle text editor tool calls separately
						if (toolCall.name === 'str_replace_based_edit_tool' && textEditorHandler) {
							const result = yield* this.executeTextEditorToolCall(
								{ name: toolCall.name, args: toolCall.args, id: toolCall.id },
								messages,
								textEditorHandler,
								{
									getValidateAttempts: () => textEditorValidateAttempts,
									incrementValidateAttempts: () => textEditorValidateAttempts++,
									getWorkflow: () => workflow,
									setWorkflow: (w: WorkflowJSON | null) => {
										workflow = w;
									},
									setSourceCode: (c: string) => {
										sourceCode = c;
									},
									setParseDuration: (d: number) => {
										parseDuration = d;
									},
								},
								currentWorkflow,
								generationErrors,
								iteration,
							);

							// If validate succeeded and workflow is ready, break the loop
							if (result?.workflowReady) {
								this.debugLog('CHAT', 'Text editor validate succeeded, exiting loop');
								break;
							}
						} else {
							yield* this.executeToolCall(
								{ name: toolCall.name, args: toolCall.args, id: toolCall.id },
								messages,
							);
						}
					}

					// Check if we should exit after text editor finalize
					if (textEditorEnabled && workflow) {
						this.debugLog('CHAT', 'Workflow ready from text editor, exiting loop');
						break;
					}

					// Check for too many validate failures in text editor mode
					if (textEditorEnabled && textEditorValidateAttempts >= MAX_VALIDATE_ATTEMPTS) {
						throw new Error(
							`Failed to generate valid workflow after ${MAX_VALIDATE_ATTEMPTS} validate attempts.`,
						);
					}
				} else if (textEditorEnabled && textEditorHandler) {
					// In text editor mode, no tool calls means LLM is done editing - auto-finalize
					this.debugLog('CHAT', 'Text editor mode: no tool calls, auto-finalizing');
					const code = textEditorHandler.getWorkflowCode();

					if (!code) {
						// No code yet - prompt to create
						this.debugLog('CHAT', 'No code exists, prompting to create');
						messages.push(
							new HumanMessage(
								'Please use the text editor tool to create or edit the workflow code.',
							),
						);
					} else {
						// Auto-validate and finalize
						textEditorValidateAttempts++;
						this.debugLog('CHAT', '========== AUTO-FINALIZE (NO TOOL CALLS) ==========', {
							attemptNumber: textEditorValidateAttempts,
							codeLength: code.length,
						});

						const parseStartTime = Date.now();
						try {
							const result = await this.parseAndValidate(code, currentWorkflow);
							parseDuration = Date.now() - parseStartTime;
							sourceCode = code;

							this.debugLog('CHAT', 'Auto-finalize: parse completed', {
								parseDurationMs: parseDuration,
								warningCount: result.warnings.length,
								nodeCount: result.workflow.nodes.length,
							});

							if (result.warnings.length > 0) {
								const warningText = result.warnings
									.map((w) => `- [${w.code}] ${w.message}`)
									.join('\n');
								const errorContext = this.getErrorContext(code, result.warnings[0].message);

								this.debugLog('CHAT', 'Auto-finalize: validation warnings', {
									warnings: result.warnings,
								});

								// Track as generation error
								generationErrors.push({
									message: `Validation warnings:\n${warningText}`,
									code,
									iteration,
									type: 'validation',
								});

								// Send warnings back to agent for correction
								messages.push(
									new HumanMessage(
										`Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace to fix these issues.`,
									),
								);
							} else {
								// Success - workflow validated, exit loop
								workflow = result.workflow;
								this.debugLog('CHAT', '========== AUTO-FINALIZE SUCCESS ==========', {
									nodeCount: result.workflow.nodes.length,
									nodeNames: result.workflow.nodes.map((n) => n.name),
								});
								break;
							}
						} catch (error) {
							parseDuration = Date.now() - parseStartTime;
							const errorMessage = error instanceof Error ? error.message : String(error);
							const errorContext = this.getErrorContext(code, errorMessage);

							this.debugLog('CHAT', '========== AUTO-FINALIZE FAILED ==========', {
								parseDurationMs: parseDuration,
								errorMessage,
							});

							// Track the generation error
							generationErrors.push({
								message: errorMessage,
								code,
								iteration,
								type: 'parse',
							});

							// Send error back to agent for correction
							messages.push(
								new HumanMessage(
									`Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace to fix these issues.`,
								),
							);
						}
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
	 * Extract thinking/planning content from an AI message
	 * Looks for <n8n_thinking> tags and extended thinking blocks
	 */
	private extractThinkingContent(message: AIMessage): string | null {
		const textContent = this.extractTextContent(message);
		if (!textContent) {
			return null;
		}

		// Extract <n8n_thinking> blocks
		const thinkingMatches = textContent.match(/<n8n_thinking>([\s\S]*?)<\/n8n_thinking>/g);
		if (thinkingMatches) {
			return thinkingMatches
				.map((match) => match.replace(/<\/?n8n_thinking>/g, '').trim())
				.join('\n\n');
		}

		// Check for extended thinking in content blocks (Claude's native thinking)
		if (Array.isArray(message.content)) {
			const thinkingBlocks = message.content
				.filter(
					(block): block is { type: 'thinking'; thinking: string } =>
						typeof block === 'object' &&
						block !== null &&
						'type' in block &&
						block.type === 'thinking',
				)
				.map((block) => block.thinking);

			if (thinkingBlocks.length > 0) {
				return thinkingBlocks.join('\n\n');
			}
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
	 * Execute a text editor tool call and yield progress updates
	 *
	 * @returns Object with workflowReady flag indicating if validate succeeded
	 */
	private async *executeTextEditorToolCall(
		toolCall: { name: string; args: Record<string, unknown>; id: string },
		messages: BaseMessage[],
		handler: TextEditorHandler,
		state: {
			getValidateAttempts: () => number;
			incrementValidateAttempts: () => void;
			getWorkflow: () => WorkflowJSON | null;
			setWorkflow: (w: WorkflowJSON | null) => void;
			setSourceCode: (c: string) => void;
			setParseDuration: (d: number) => void;
		},
		currentWorkflow: WorkflowJSON | undefined,
		generationErrors: StreamGenerationError[],
		iteration: number,
	): AsyncGenerator<StreamOutput, { workflowReady: boolean } | undefined, unknown> {
		const command = toolCall.args as unknown as TextEditorCommand;
		this.debugLog('TEXT_EDITOR', `Executing text editor command: ${command.command}`, {
			toolCallId: toolCall.id,
			command,
		});

		// Stream tool progress
		yield {
			messages: [
				{
					type: 'tool',
					toolName: 'text_editor',
					displayTitle: 'Crafting workflow',
					status: 'running',
					args: toolCall.args,
				} as ToolProgressChunk,
			],
		};

		// Handle validate separately - triggers validation but doesn't auto-complete
		if (command.command === 'validate') {
			const attemptNumber = state.getValidateAttempts() + 1;
			state.incrementValidateAttempts();
			this.debugLog('TEXT_EDITOR', '========== VALIDATE ATTEMPT ==========', {
				attemptNumber,
				iteration,
			});

			const code = handler.getWorkflowCode();

			if (!code) {
				this.debugLog('TEXT_EDITOR', 'Validate failed: no code exists');
				messages.push(
					new ToolMessage({
						tool_call_id: toolCall.id,
						content: 'Error: No workflow code to validate. Use str_replace to add code first.',
					}),
				);
				yield {
					messages: [
						{
							type: 'tool',
							toolName: 'text_editor',
							displayTitle: 'Crafting workflow',
							status: 'completed',
						} as ToolProgressChunk,
					],
				};
				return { workflowReady: false };
			}

			this.debugLog('TEXT_EDITOR', 'Validate: code to check', {
				codeLength: code.length,
				codeLines: code.split('\n').length,
				code,
			});

			const parseStartTime = Date.now();
			try {
				const result = await this.parseAndValidate(code, currentWorkflow);
				const parseDuration = Date.now() - parseStartTime;
				state.setParseDuration(parseDuration);
				state.setSourceCode(code);

				this.debugLog('TEXT_EDITOR', 'Validate: parse completed', {
					parseDurationMs: parseDuration,
					warningCount: result.warnings.length,
					nodeCount: result.workflow.nodes.length,
				});

				if (result.warnings.length > 0) {
					const warningText = result.warnings.map((w) => `- [${w.code}] ${w.message}`).join('\n');
					const errorContext = this.getErrorContext(code, result.warnings[0].message);

					this.debugLog('TEXT_EDITOR', 'Validate: validation warnings', {
						warnings: result.warnings,
						errorContext,
					});

					// Track as generation error
					generationErrors.push({
						message: `Validation warnings:\n${warningText}`,
						code,
						iteration,
						type: 'validation',
					});

					messages.push(
						new ToolMessage({
							tool_call_id: toolCall.id,
							content: `Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace to fix these issues.`,
						}),
					);
					state.setWorkflow(null);
					yield {
						messages: [
							{
								type: 'tool',
								toolName: 'text_editor',
								displayTitle: 'Crafting workflow',
								status: 'completed',
							} as ToolProgressChunk,
						],
					};
					return { workflowReady: false };
				}

				// Validation passed - return success message but don't complete
				// (workflow will auto-finalize when LLM stops calling tools)
				messages.push(
					new ToolMessage({
						tool_call_id: toolCall.id,
						content: 'Validation passed. Workflow code is valid.',
					}),
				);
				this.debugLog('TEXT_EDITOR', '========== VALIDATE SUCCESS ==========', {
					nodeCount: result.workflow.nodes.length,
					nodeNames: result.workflow.nodes.map((n) => n.name),
					nodeTypes: result.workflow.nodes.map((n) => n.type),
				});
				yield {
					messages: [
						{
							type: 'tool',
							toolName: 'text_editor',
							displayTitle: 'Crafting workflow',
							status: 'completed',
						} as ToolProgressChunk,
					],
				};
				// Don't set workflow ready - let auto-finalize happen when LLM stops calling tools
				return { workflowReady: false };
			} catch (error) {
				const parseDuration = Date.now() - parseStartTime;
				state.setParseDuration(parseDuration);
				const errorMessage = error instanceof Error ? error.message : String(error);
				const errorStack = error instanceof Error ? error.stack : undefined;
				const errorContext = this.getErrorContext(code, errorMessage);

				this.debugLog('TEXT_EDITOR', '========== VALIDATE FAILED ==========', {
					parseDurationMs: parseDuration,
					errorMessage,
					errorStack,
					errorContext,
				});

				// Track the generation error
				generationErrors.push({
					message: errorMessage,
					code,
					iteration,
					type: 'parse',
				});

				messages.push(
					new ToolMessage({
						tool_call_id: toolCall.id,
						content: `Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace to fix these issues.`,
					}),
				);
				yield {
					messages: [
						{
							type: 'tool',
							toolName: 'text_editor',
							displayTitle: 'Crafting workflow',
							status: 'completed',
						} as ToolProgressChunk,
					],
				};
				return { workflowReady: false };
			}
		}

		// Execute non-finalize commands (view, create, str_replace, insert)
		try {
			const result = handler.execute(command);
			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id,
					content: result,
				}),
			);
			this.debugLog('TEXT_EDITOR', `Command ${command.command} executed successfully`, {
				result,
			});

			// Auto-validate after create to check immediately
			if (command.command === 'create') {
				this.debugLog('TEXT_EDITOR', 'Auto-validating after create command');
				const code = handler.getWorkflowCode();

				if (code) {
					const parseStartTime = Date.now();
					try {
						const parseResult = await this.parseAndValidate(code, currentWorkflow);
						const parseDuration = Date.now() - parseStartTime;
						state.setParseDuration(parseDuration);
						state.setSourceCode(code);

						this.debugLog('TEXT_EDITOR', 'Auto-validate: parse completed', {
							parseDurationMs: parseDuration,
							warningCount: parseResult.warnings.length,
							nodeCount: parseResult.workflow.nodes.length,
						});

						if (parseResult.warnings.length > 0) {
							const warningText = parseResult.warnings
								.map((w) => `- [${w.code}] ${w.message}`)
								.join('\n');
							const errorContext = this.getErrorContext(code, parseResult.warnings[0].message);

							this.debugLog('TEXT_EDITOR', 'Auto-validate: validation warnings', {
								warnings: parseResult.warnings,
								errorContext,
							});

							// Track as generation error
							generationErrors.push({
								message: `Validation warnings:\n${warningText}`,
								code,
								iteration,
								type: 'validation',
							});

							messages.push(
								new HumanMessage(
									`Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace to fix these issues.`,
								),
							);
							state.setWorkflow(null);
							yield {
								messages: [
									{
										type: 'tool',
										toolName: 'text_editor',
										displayTitle: 'Crafting workflow',
										status: 'completed',
									} as ToolProgressChunk,
								],
							};
							return { workflowReady: false };
						}

						// Validation passed - workflow is ready
						state.setWorkflow(parseResult.workflow);
						state.incrementValidateAttempts(); // Count as a validate attempt
						this.debugLog('TEXT_EDITOR', '========== AUTO-VALIDATE SUCCESS (CREATE) ==========', {
							nodeCount: parseResult.workflow.nodes.length,
							nodeNames: parseResult.workflow.nodes.map((n) => n.name),
							nodeTypes: parseResult.workflow.nodes.map((n) => n.type),
						});
						yield {
							messages: [
								{
									type: 'tool',
									toolName: 'text_editor',
									displayTitle: 'Crafting workflow',
									status: 'completed',
								} as ToolProgressChunk,
							],
						};
						return { workflowReady: true };
					} catch (error) {
						const parseDuration = Date.now() - parseStartTime;
						state.setParseDuration(parseDuration);
						const errorMessage = error instanceof Error ? error.message : String(error);
						const errorStack = error instanceof Error ? error.stack : undefined;
						const errorContext = this.getErrorContext(code, errorMessage);

						this.debugLog('TEXT_EDITOR', '========== AUTO-VALIDATE FAILED (CREATE) ==========', {
							parseDurationMs: parseDuration,
							errorMessage,
							errorStack,
							errorContext,
						});

						// Track the generation error
						generationErrors.push({
							message: errorMessage,
							code,
							iteration,
							type: 'parse',
						});

						messages.push(
							new HumanMessage(
								`Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace to fix these issues.`,
							),
						);
						yield {
							messages: [
								{
									type: 'tool',
									toolName: 'text_editor',
									displayTitle: 'Crafting workflow',
									status: 'completed',
								} as ToolProgressChunk,
							],
						};
						return { workflowReady: false };
					}
				}
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id,
					content: `Error: ${errorMessage}`,
				}),
			);
			this.debugLog('TEXT_EDITOR', `Command ${command.command} failed`, { error: errorMessage });
		}

		yield {
			messages: [
				{
					type: 'tool',
					toolName: 'text_editor',
					displayTitle: 'Crafting workflow',
					status: 'completed',
				} as ToolProgressChunk,
			],
		};
		return undefined;
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
		if (!workflowCode?.includes('workflow')) {
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

		// Strip import statements before parsing - SDK functions are available as globals
		const codeToparse = stripImportStatements(code);
		this.debugLog('PARSE_VALIDATE', 'Code after stripping imports', {
			originalLength: code.length,
			strippedLength: codeToparse.length,
		});

		try {
			// Parse the TypeScript code to WorkflowBuilder
			this.logger?.debug('Parsing WorkflowCode', { codeLength: codeToparse.length });
			this.debugLog('PARSE_VALIDATE', 'Calling parseWorkflowCodeToBuilder...');
			const parseStartTime = Date.now();
			const builder = parseWorkflowCodeToBuilder(codeToparse);
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
