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
import { generateWorkflowCode } from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import {
	MAX_AGENT_ITERATIONS,
	MAX_VALIDATE_ATTEMPTS,
	FIX_AND_FINALIZE_INSTRUCTION,
	TEXT_EDITOR_TOOL,
	VALIDATE_TOOL,
} from './constants';
import { AutoFinalizeHandler } from './handlers/auto-finalize-handler';
import { ParseValidateHandler } from './handlers/parse-validate-handler';
import { calculateCost } from './utils/cost-calculator';
import { extractTextContent, extractThinkingContent } from './utils/content-extractors';
import type { WorkflowCodeOutput, CodeBuilderAgentConfig } from './types';
export type { CodeBuilderAgentConfig } from './types';
import { buildCodeBuilderPrompt, type HistoryContext } from '../prompts/code-builder';
import { createCodeBuilderGetTool } from '../tools/code-builder-get.tool';
import { createCodeBuilderSearchTool } from '../tools/code-builder-search.tool';
import { createGetSuggestedNodesTool } from '../tools/get-suggested-nodes.tool';
import { TextEditorHandler } from '../tools/text-editor-handler';
import type {
	StreamOutput,
	AgentMessageChunk,
	WorkflowUpdateChunk,
	ToolProgressChunk,
	StreamGenerationError,
	SessionMessagesChunk,
} from '../types/streaming';
import type { TextEditorCommand } from '../types/text-editor';
import type { EvaluationLogger } from '../utils/evaluation-logger';
import { extractWorkflowCode, SDK_IMPORT_STATEMENT } from '../utils/extract-code';
import { NodeTypeParser } from '../utils/node-type-parser';
import type { ChatPayload } from '../workflow-builder-agent';

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
	private parseValidateHandler: ParseValidateHandler;
	private autoFinalizeHandler: AutoFinalizeHandler;
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

		// Initialize parse/validate handler with debug logging
		this.parseValidateHandler = new ParseValidateHandler({
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
			logger: config.logger,
		});

		// Initialize auto-finalize handler
		this.autoFinalizeHandler = new AutoFinalizeHandler({
			parseAndValidate: (code, currentWorkflow) =>
				this.parseValidateHandler.parseAndValidate(code, currentWorkflow),
			getErrorContext: (code, errorMessage) =>
				this.parseValidateHandler.getErrorContext(code, errorMessage),
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
		});

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

			// Generate workflow code ONCE with full execution context
			// This ensures both the system prompt and text editor reference identical content
			let preGeneratedWorkflowCode: string | undefined;
			if (currentWorkflow) {
				preGeneratedWorkflowCode = generateWorkflowCode({
					workflow: currentWorkflow,
					executionSchema: payload.workflowContext?.executionSchema,
					executionData: payload.workflowContext?.executionData,
					expressionValues: payload.workflowContext?.expressionValues,
				});
				this.debugLog('CHAT', 'Pre-generated workflow code with execution context', {
					codeLength: preGeneratedWorkflowCode.length,
					hasExecutionSchema: !!payload.workflowContext?.executionSchema,
					hasExecutionData: !!payload.workflowContext?.executionData,
					hasExpressionValues: !!payload.workflowContext?.expressionValues,
				});
			}

			// Check if text editor mode should be enabled
			const textEditorEnabled = this.shouldEnableTextEditor();
			this.debugLog('CHAT', 'Text editor mode', { textEditorEnabled });

			const prompt = buildCodeBuilderPrompt(currentWorkflow, historyContext, {
				enableTextEditor: textEditorEnabled,
				executionSchema: payload.workflowContext?.executionSchema,
				executionData: payload.workflowContext?.executionData,
				expressionValues: payload.workflowContext?.expressionValues,
				preGeneratedCode: preGeneratedWorkflowCode,
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
			const toolsToUse = textEditorEnabled
				? [...this.tools, TEXT_EDITOR_TOOL, VALIDATE_TOOL]
				: this.tools;
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
					contentPreview: content,
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
			// Track warnings that have been sent to agent (to avoid repeating)
			// Uses "code|nodeName|parameterPath" as key to deduplicate by location, not message content
			const previousWarnings = new Set<string>();

			// Text editor mode state
			let textEditorHandler: TextEditorHandler | null = null;
			let textEditorValidateAttempts = 0;
			let validatePassedThisIteration = false;

			if (textEditorEnabled) {
				// Pass debug log function to handler for detailed logging
				textEditorHandler = new TextEditorHandler((context, message, data) => {
					this.debugLog(`TEXT_EDITOR_HANDLER:${context}`, message, data);
				});

				// Pre-populate with the SAME code that's in the system prompt
				// This ensures str_replace commands match what the LLM sees
				if (preGeneratedWorkflowCode) {
					const codeWithImport = `${SDK_IMPORT_STATEMENT}\n\n${preGeneratedWorkflowCode}`;
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
				validatePassedThisIteration = false;
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
				const thinkingContent = extractThinkingContent(response);
				if (thinkingContent) {
					this.debugLog('CHAT', '========== AGENT THINKING/PLANNING ==========', {
						thinkingContent,
					});
				}

				// Extract text content from response
				const textContent = extractTextContent(response);
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

							// If create command auto-validated successfully, break the loop
							if (result?.workflowReady) {
								this.debugLog('CHAT', 'Text editor auto-validate succeeded, exiting loop');
								break;
							}
						} else if (toolCall.name === 'validate_workflow' && textEditorHandler) {
							// Handle validate_workflow tool
							const result = yield* this.executeValidateTool(
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
									getPreviousWarnings: () => previousWarnings,
									addWarnings: (keys: string[]) => {
										keys.forEach((k) => previousWarnings.add(k));
									},
								},
								currentWorkflow,
								generationErrors,
								iteration,
							);

							// If validate succeeded, the workflow is validated but we don't exit the loop
							// Let auto-finalize happen when LLM stops calling tools
							if (result?.workflowReady) {
								this.debugLog('CHAT', 'Validate tool succeeded, letting agent finalize');
								validatePassedThisIteration = true;
							}
						} else {
							yield* this.executeToolCall(
								{ name: toolCall.name, args: toolCall.args, id: toolCall.id },
								messages,
							);
						}
					}

					// Check if we should exit after text editor finalize
					// Skip if validate just passed - let agent have another turn to finalize
					if (textEditorEnabled && workflow && !validatePassedThisIteration) {
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
					textEditorValidateAttempts++;

					const autoFinalizeResult = yield* this.autoFinalizeHandler.execute({
						code: textEditorHandler.getWorkflowCode(),
						currentWorkflow,
						iteration,
						messages,
						generationErrors,
					});

					if (autoFinalizeResult.success && autoFinalizeResult.workflow) {
						workflow = autoFinalizeResult.workflow;
						sourceCode = autoFinalizeResult.sourceCode ?? null;
						parseDuration = autoFinalizeResult.parseDuration ?? 0;
						break;
					}
					if (autoFinalizeResult.parseDuration) {
						parseDuration = autoFinalizeResult.parseDuration;
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
							const result = await this.parseValidateHandler.parseAndValidate(
								finalResult.workflowCode,
								currentWorkflow,
							);
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
							// Use code|nodeName|parameterPath as key to deduplicate by location, not message content
							const newWarnings = result.warnings.filter(
								(w) =>
									!previousWarnings.has(`${w.code}|${w.nodeName || ''}|${w.parameterPath || ''}`),
							);

							if (newWarnings.length > 0) {
								this.debugLog('CHAT', 'New validation warnings found', {
									newWarningCount: newWarnings.length,
									warnings: newWarnings,
								});

								// Mark these warnings as sent (so we don't repeat)
								for (const w of newWarnings) {
									previousWarnings.add(`${w.code}|${w.nodeName || ''}|${w.parameterPath || ''}`);
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

			// Yield session messages for persistence (includes tool calls and results)
			yield {
				messages: [
					{
						type: 'session-messages',
						messages,
					} as SessionMessagesChunk,
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
	 * @returns Object with workflowReady flag indicating if auto-validate succeeded (for create command)
	 */
	private async *executeTextEditorToolCall(
		toolCall: { name: string; args: Record<string, unknown>; id: string },
		messages: BaseMessage[],
		handler: TextEditorHandler,
		state: {
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

		// Execute text editor commands (view, create, str_replace, insert)
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
						const parseResult = await this.parseValidateHandler.parseAndValidate(
							code,
							currentWorkflow,
						);
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
							const errorContext = this.parseValidateHandler.getErrorContext(
								code,
								parseResult.warnings[0].message,
							);

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
									`Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
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
						const errorContext = this.parseValidateHandler.getErrorContext(code, errorMessage);

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
								`Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
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
	 * Execute the validate_workflow tool call and yield progress updates
	 *
	 * @returns Object with workflowReady flag indicating if validation passed
	 */
	private async *executeValidateTool(
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
			getPreviousWarnings: () => Set<string>;
			addWarnings: (keys: string[]) => void;
		},
		currentWorkflow: WorkflowJSON | undefined,
		generationErrors: StreamGenerationError[],
		iteration: number,
	): AsyncGenerator<StreamOutput, { workflowReady: boolean }, unknown> {
		const attemptNumber = state.getValidateAttempts() + 1;
		state.incrementValidateAttempts();
		this.debugLog('VALIDATE_TOOL', '========== VALIDATE ATTEMPT ==========', {
			attemptNumber,
			iteration,
			toolCallId: toolCall.id,
		});

		// Stream tool progress
		yield {
			messages: [
				{
					type: 'tool',
					toolName: 'validate_workflow',
					displayTitle: 'Validating workflow',
					status: 'running',
					args: toolCall.args,
				} as ToolProgressChunk,
			],
		};

		const code = handler.getWorkflowCode();

		if (!code) {
			this.debugLog('VALIDATE_TOOL', 'Validate failed: no code exists');
			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id,
					content:
						'Error: No workflow code to validate. Use str_replace_based_edit_tool to add code first.',
				}),
			);
			yield {
				messages: [
					{
						type: 'tool',
						toolName: 'validate_workflow',
						displayTitle: 'Validating workflow',
						status: 'completed',
					} as ToolProgressChunk,
				],
			};
			return { workflowReady: false };
		}

		this.debugLog('VALIDATE_TOOL', 'Validate: code to check', {
			codeLength: code.length,
			codeLines: code.split('\n').length,
			code,
		});

		const parseStartTime = Date.now();
		try {
			const result = await this.parseValidateHandler.parseAndValidate(code, currentWorkflow);
			const parseDuration = Date.now() - parseStartTime;
			state.setParseDuration(parseDuration);
			state.setSourceCode(code);

			this.debugLog('VALIDATE_TOOL', 'Validate: parse completed', {
				parseDurationMs: parseDuration,
				warningCount: result.warnings.length,
				nodeCount: result.workflow.nodes.length,
			});

			if (result.warnings.length > 0) {
				// Filter out warnings that have already been shown to the agent
				// Use code|nodeName|parameterPath as key to deduplicate by location, not message content
				const previousWarnings = state.getPreviousWarnings();
				const newWarnings = result.warnings.filter((w) => {
					const key = `${w.code}|${w.nodeName || ''}|${w.parameterPath || ''}`;
					return !previousWarnings.has(key);
				});

				this.debugLog('VALIDATE_TOOL', 'Validate: validation warnings', {
					totalWarnings: result.warnings.length,
					newWarnings: newWarnings.length,
					repeatedWarnings: result.warnings.length - newWarnings.length,
					warnings: result.warnings,
				});

				if (newWarnings.length > 0) {
					// Track new warnings so we don't repeat them
					const newWarningKeys = newWarnings.map(
						(w) => `${w.code}|${w.nodeName || ''}|${w.parameterPath || ''}`,
					);
					state.addWarnings(newWarningKeys);

					const warningText = newWarnings.map((w) => `- [${w.code}] ${w.message}`).join('\n');
					const errorContext = this.parseValidateHandler.getErrorContext(
						code,
						newWarnings[0].message,
					);

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
							content: `Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace_based_edit_tool to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
						}),
					);
					state.setWorkflow(null);

					// Stream partial workflow to frontend for progressive rendering
					// even when there are warnings, so users can see progress
					yield {
						messages: [
							{
								role: 'assistant',
								type: 'workflow-updated',
								codeSnippet: JSON.stringify(result.workflow, null, 2),
								sourceCode: code,
							} as WorkflowUpdateChunk,
						],
					};

					yield {
						messages: [
							{
								type: 'tool',
								toolName: 'validate_workflow',
								displayTitle: 'Validating workflow',
								status: 'completed',
							} as ToolProgressChunk,
						],
					};
					return { workflowReady: false };
				}

				// All warnings are repeated - treat as success and prompt to finalize
				this.debugLog('VALIDATE_TOOL', 'All warnings are repeated, prompting agent to finalize');
			}

			// Validation passed (or only repeated warnings) - save workflow and prompt to finalize
			// We must set the workflow here to handle edge cases where this is the last iteration
			// and the LLM doesn't get another turn to stop calling tools (auto-finalize can't happen)
			state.setWorkflow(result.workflow);
			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id,
					content:
						'Validation passed. Workflow code is valid.\n\nIMPORTANT: Stop calling tools now to finalize the workflow.',
				}),
			);
			this.debugLog('VALIDATE_TOOL', '========== VALIDATE SUCCESS ==========', {
				nodeCount: result.workflow.nodes.length,
				nodeNames: result.workflow.nodes.map((n) => n.name),
				nodeTypes: result.workflow.nodes.map((n) => n.type),
			});

			// Stream workflow update to frontend for progressive rendering
			yield {
				messages: [
					{
						role: 'assistant',
						type: 'workflow-updated',
						codeSnippet: JSON.stringify(result.workflow, null, 2),
						sourceCode: code,
					} as WorkflowUpdateChunk,
				],
			};

			yield {
				messages: [
					{
						type: 'tool',
						toolName: 'validate_workflow',
						displayTitle: 'Validating workflow',
						status: 'completed',
					} as ToolProgressChunk,
				],
			};
			// Return workflowReady: true so main loop knows validation passed
			// Main loop will let agent have another turn to finalize
			return { workflowReady: true };
		} catch (error) {
			const parseDuration = Date.now() - parseStartTime;
			state.setParseDuration(parseDuration);
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorStack = error instanceof Error ? error.stack : undefined;
			const errorContext = this.parseValidateHandler.getErrorContext(code, errorMessage);

			this.debugLog('VALIDATE_TOOL', '========== VALIDATE FAILED ==========', {
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
					content: `Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace_based_edit_tool to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
				}),
			);
			yield {
				messages: [
					{
						type: 'tool',
						toolName: 'validate_workflow',
						displayTitle: 'Validating workflow',
						status: 'completed',
					} as ToolProgressChunk,
				],
			};
			return { workflowReady: false };
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
		const content = extractTextContent(message);
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
}
