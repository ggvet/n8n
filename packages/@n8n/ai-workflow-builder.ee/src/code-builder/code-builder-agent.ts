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
import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';
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
	TEXT_EDITOR_TOOL,
	VALIDATE_TOOL,
} from './constants';
import { AgentIterationHandler } from './handlers/agent-iteration-handler';
import { AutoFinalizeHandler } from './handlers/auto-finalize-handler';
import { FinalResponseHandler } from './handlers/final-response-handler';
import { ParseValidateHandler } from './handlers/parse-validate-handler';
import { TextEditorToolHandler } from './handlers/text-editor-tool-handler';
import { ValidateToolHandler } from './handlers/validate-tool-handler';
import { WarningTracker } from './state/warning-tracker';
import type { CodeBuilderAgentConfig } from './types';
export type { CodeBuilderAgentConfig } from './types';
import { buildCodeBuilderPrompt, type HistoryContext } from './prompts';
import { createCodeBuilderGetTool } from './tools/code-builder-get.tool';
import { createCodeBuilderSearchTool } from './tools/code-builder-search.tool';
import { createGetSuggestedNodesTool } from './tools/get-suggested-nodes.tool';
import { TextEditorHandler } from './handlers/text-editor-handler';
import type {
	StreamOutput,
	AgentMessageChunk,
	WorkflowUpdateChunk,
	ToolProgressChunk,
	SessionMessagesChunk,
} from '../types/streaming';
import type { TextEditorCommand } from './handlers/text-editor.types';
import type { EvaluationLogger } from './utils/evaluation-logger';
import { SDK_IMPORT_STATEMENT } from './utils/extract-code';
import { NodeTypeParser } from './utils/node-type-parser';
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
	private validateToolHandler: ValidateToolHandler;
	private iterationHandler: AgentIterationHandler;
	private finalResponseHandler: FinalResponseHandler;
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
			parseAndValidate: async (code, currentWorkflow) =>
				await this.parseValidateHandler.parseAndValidate(code, currentWorkflow),
			getErrorContext: (code, errorMessage) =>
				this.parseValidateHandler.getErrorContext(code, errorMessage),
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
		});

		// Initialize validate tool handler
		this.validateToolHandler = new ValidateToolHandler({
			parseAndValidate: async (code, currentWorkflow) =>
				await this.parseValidateHandler.parseAndValidate(code, currentWorkflow),
			getErrorContext: (code, errorMessage) =>
				this.parseValidateHandler.getErrorContext(code, errorMessage),
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
		});

		// Initialize iteration handler
		this.iterationHandler = new AgentIterationHandler({
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
		});

		// Initialize final response handler
		this.finalResponseHandler = new FinalResponseHandler({
			parseAndValidate: async (code, currentWorkflow) =>
				await this.parseValidateHandler.parseAndValidate(code, currentWorkflow),
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
			evalLogger: config.evalLogger,
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
			let totalInputTokens = 0;
			let totalOutputTokens = 0;
			let consecutiveParseErrors = 0;
			let workflow: WorkflowJSON | null = null;
			let parseDuration = 0;
			// Track source code for evaluations (only populated when evalLogger is present)
			let sourceCode: string | null = null;
			// Track warnings that have been sent to agent (to avoid repeating)
			const warningTracker = new WarningTracker();

			// Text editor mode state
			let textEditorHandler: TextEditorHandler | null = null;
			let textEditorToolHandler: TextEditorToolHandler | null = null;
			let textEditorValidateAttempts = 0;
			let validatePassedThisIteration = false;

			if (textEditorEnabled) {
				// Pass debug log function to handler for detailed logging
				textEditorHandler = new TextEditorHandler((context, message, data) => {
					this.debugLog(`TEXT_EDITOR_HANDLER:${context}`, message, data);
				});

				// Create text editor tool handler (wraps the text editor handler)
				textEditorToolHandler = new TextEditorToolHandler({
					textEditorExecute: (args) =>
						textEditorHandler!.execute(args as unknown as TextEditorCommand),
					textEditorGetCode: () => textEditorHandler!.getWorkflowCode(),
					parseAndValidate: async (code, workflowCtx) =>
						await this.parseValidateHandler.parseAndValidate(code, workflowCtx),
					getErrorContext: (code, errorMessage) =>
						this.parseValidateHandler.getErrorContext(code, errorMessage),
					debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
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

				// Invoke LLM and stream response using iteration handler
				const llmResult = yield* this.iterationHandler.invokeLlm({
					llmWithTools,
					messages,
					abortSignal,
					iteration,
				});

				// Track token usage
				totalInputTokens += llmResult.inputTokens;
				totalOutputTokens += llmResult.outputTokens;

				// Check if there are tool calls
				const response = llmResult.response;
				if (llmResult.hasToolCalls && response.tool_calls) {
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
						if (toolCall.name === 'str_replace_based_edit_tool' && textEditorToolHandler) {
							const result = yield* textEditorToolHandler.execute({
								toolCallId: toolCall.id,
								args: toolCall.args,
								currentWorkflow,
								iteration,
								messages,
							});

							// Update local state from handler result
							if (result?.workflow) {
								workflow = result.workflow;
							}

							// If create command auto-validated successfully, break the loop
							if (result?.workflowReady) {
								this.debugLog('CHAT', 'Text editor auto-validate succeeded, exiting loop');
								// Capture source code for evaluations
								if (this.evalLogger) {
									sourceCode = textEditorHandler!.getWorkflowCode();
								}
								break;
							}
						} else if (toolCall.name === 'validate_workflow' && textEditorToolHandler) {
							// Handle validate_workflow tool
							textEditorValidateAttempts++;
							const result = yield* this.validateToolHandler.execute({
								toolCallId: toolCall.id,
								code: textEditorHandler!.getWorkflowCode(),
								currentWorkflow,
								iteration,
								messages,
								warningTracker,
							});

							// Update local state from handler result
							if (result.parseDuration !== undefined) {
								parseDuration = result.parseDuration;
							}
							if (result.workflow) {
								workflow = result.workflow;
							}

							// If validate succeeded, the workflow is validated but we don't exit the loop
							// Let auto-finalize happen when LLM stops calling tools
							if (result.workflowReady) {
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
						// Capture source code for evaluations
						if (this.evalLogger && textEditorHandler) {
							sourceCode = textEditorHandler.getWorkflowCode();
						}
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
						messages,
					});

					if (autoFinalizeResult.success && autoFinalizeResult.workflow) {
						workflow = autoFinalizeResult.workflow;
						parseDuration = autoFinalizeResult.parseDuration ?? 0;
						// Capture source code for evaluations
						if (this.evalLogger) {
							sourceCode = textEditorHandler.getWorkflowCode();
						}
						break;
					}
					if (autoFinalizeResult.parseDuration) {
						parseDuration = autoFinalizeResult.parseDuration;
					}
				} else {
					// No tool calls - try to parse as final response
					const finalResult = await this.finalResponseHandler.process({
						response: llmResult.response,
						currentWorkflow,
						messages,
						warningTracker,
					});

					// Update local state from handler result
					if (finalResult.parseDuration !== undefined) {
						parseDuration = finalResult.parseDuration;
					}
					if (finalResult.isParseError) {
						consecutiveParseErrors++;
					}

					// Check result
					if (finalResult.success && finalResult.workflow) {
						workflow = finalResult.workflow;
						// Capture source code for evaluations
						if (this.evalLogger && finalResult.sourceCode) {
							sourceCode = finalResult.sourceCode;
						}
						break;
					}
					// Otherwise, shouldContinue is implied - loop continues
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

			this.debugLog('CHAT', 'Request stats', {
				totalDurationMs: totalDuration,
				totalInputTokens,
				totalOutputTokens,
			});

			// Stream workflow update
			this.debugLog('CHAT', 'Streaming workflow update');
			yield {
				messages: [
					{
						role: 'assistant',
						type: 'workflow-updated',
						codeSnippet: JSON.stringify(workflow, null, 2),
						iterationCount: iteration,
						// Only include sourceCode during evaluations
						...(this.evalLogger && sourceCode ? { sourceCode } : {}),
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
}
