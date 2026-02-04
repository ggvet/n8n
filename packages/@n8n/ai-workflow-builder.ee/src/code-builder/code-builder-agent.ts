/**
 * Code Builder Agent
 *
 * Unified agent that generates complete workflows using TypeScript SDK format with an agentic loop
 * that handles tool calls for node discovery before producing the final workflow.
 *
 * This replaces the split Planning Agent + Coding Agent architecture by combining both
 * discovery and code generation in a single, context-preserving agent.
 */

import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { Logger } from '@n8n/backend-common';
import type { WorkflowJSON } from '@n8n/workflow-sdk';
import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';

import type {
	StreamOutput,
	AgentMessageChunk,
	WorkflowUpdateChunk,
	SessionMessagesChunk,
} from '../types/streaming';
import type { ChatPayload } from '../workflow-builder-agent';
import { MAX_AGENT_ITERATIONS, MAX_VALIDATE_ATTEMPTS } from './constants';
import { AgentIterationHandler } from './handlers/agent-iteration-handler';
import { AutoFinalizeHandler } from './handlers/auto-finalize-handler';
import { ChatSetupHandler, type LlmWithTools } from './handlers/chat-setup-handler';
import { FinalResponseHandler } from './handlers/final-response-handler';
import { ParseValidateHandler } from './handlers/parse-validate-handler';
import type { TextEditorHandler } from './handlers/text-editor-handler';
import type { TextEditorToolHandler } from './handlers/text-editor-tool-handler';
import { ToolDispatchHandler } from './handlers/tool-dispatch-handler';
import { ValidateToolHandler } from './handlers/validate-tool-handler';
import type { HistoryContext } from './prompts';
import { WarningTracker } from './state/warning-tracker';
import { createCodeBuilderGetTool } from './tools/code-builder-get.tool';
import { createCodeBuilderSearchTool } from './tools/code-builder-search.tool';
import { createGetSuggestedNodesTool } from './tools/get-suggested-nodes.tool';
import type { CodeBuilderAgentConfig } from './types';
export type { CodeBuilderAgentConfig } from './types';
import type { EvaluationLogger } from './utils/evaluation-logger';
import { NodeTypeParser } from './utils/node-type-parser';

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
	private nodeTypeParser: NodeTypeParser;
	private logger?: Logger;
	private evalLogger?: EvaluationLogger;
	private tools: StructuredToolInterface[];
	private toolsMap: Map<string, StructuredToolInterface>;
	private parseValidateHandler: ParseValidateHandler;
	private autoFinalizeHandler: AutoFinalizeHandler;
	private validateToolHandler: ValidateToolHandler;
	private iterationHandler: AgentIterationHandler;
	private finalResponseHandler: FinalResponseHandler;
	private chatSetupHandler: ChatSetupHandler;
	private toolDispatchHandler: ToolDispatchHandler;
	/** @TODO Current session log file path (for temporary file-based logging) */
	private currentLogFile: string | null = null;

	constructor(config: CodeBuilderAgentConfig) {
		/** @TODO Lots of temporary logging to be cleaned up */
		this.debugLog('CONSTRUCTOR', 'Initializing CodeBuilderAgent...', {
			nodeTypesCount: config.nodeTypes.length,
			hasLogger: !!config.logger,
		});
		this.nodeTypeParser = new NodeTypeParser(config.nodeTypes);
		this.logger = config.logger;
		this.evalLogger = config.evalLogger;

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

		// Initialize chat setup handler
		this.chatSetupHandler = new ChatSetupHandler({
			llm: config.llm,
			tools: this.tools,
			enableTextEditorConfig: config.enableTextEditor,
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
			parseAndValidate: async (code, currentWorkflow) =>
				await this.parseValidateHandler.parseAndValidate(code, currentWorkflow),
			getErrorContext: (code, errorMessage) =>
				this.parseValidateHandler.getErrorContext(code, errorMessage),
		});

		// Initialize tool dispatch handler
		this.toolDispatchHandler = new ToolDispatchHandler({
			toolsMap: this.toolsMap,
			validateToolHandler: this.validateToolHandler,
			debugLog: (ctx, msg, data) => this.debugLog(ctx, msg, data),
			evalLogger: config.evalLogger,
		});

		this.debugLog('CONSTRUCTOR', 'CodeBuilderAgent initialized', {
			toolNames: this.tools.map((t) => t.name),
		});
	}

	/**
	 * Initialize a log file for the current chat session.
	 * Creates a file with timestamp, workflow ID, and prompt snippet in the name.
	 * @TODO remove before merge. Temporary helper for quick local debugging.
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

			// Setup phase - build prompt, bind tools, format messages, initialize handlers
			this.debugLog('CHAT', 'Running setup phase...');
			const setupResult = await this.chatSetupHandler.execute({
				payload,
				historyContext,
			});

			const {
				llmWithTools,
				messages,
				textEditorEnabled,
				currentWorkflow,
				textEditorHandler,
				textEditorToolHandler,
			} = setupResult;

			// Run agentic loop
			const loopResult = yield* this.runAgenticLoop({
				llmWithTools,
				messages,
				textEditorEnabled,
				currentWorkflow,
				textEditorHandler,
				textEditorToolHandler,
				abortSignal,
			});

			const { workflow, parseDuration, sourceCode, iteration } = loopResult;

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

			const totalDuration = Date.now() - startTime;
			this.debugLog('CHAT', '========== CHAT COMPLETE ==========', {
				totalDurationMs: totalDuration,
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
	 * Run the agentic loop that invokes LLM and processes tool calls
	 */
	private async *runAgenticLoop(
		params: AgenticLoopParams,
	): AsyncGenerator<StreamOutput, AgenticLoopResult, unknown> {
		const {
			llmWithTools,
			messages,
			textEditorEnabled,
			currentWorkflow,
			textEditorHandler,
			textEditorToolHandler,
			abortSignal,
		} = params;

		this.debugLog('CHAT', 'Starting agentic loop...');
		const state: AgenticLoopState = {
			iteration: 0,
			consecutiveParseErrors: 0,
			workflow: null,
			parseDuration: 0,
			sourceCode: null,
			textEditorValidateAttempts: 0,
			warningTracker: new WarningTracker(),
		};

		while (state.iteration < MAX_AGENT_ITERATIONS) {
			this.checkConsecutiveParseErrors(state.consecutiveParseErrors);
			state.iteration++;

			// Invoke LLM and stream response
			const llmResult = yield* this.iterationHandler.invokeLlm({
				llmWithTools,
				messages,
				abortSignal,
				iteration: state.iteration,
			});

			const iterationResult = yield* this.processIteration({
				llmResult,
				messages,
				currentWorkflow,
				textEditorEnabled,
				textEditorHandler,
				textEditorToolHandler,
				state,
			});

			if (iterationResult.shouldBreak) {
				break;
			}
		}

		return {
			workflow: state.workflow,
			parseDuration: state.parseDuration,
			sourceCode: state.sourceCode,
			iteration: state.iteration,
		};
	}

	/**
	 * Check if we've hit the consecutive parse error limit
	 */
	private checkConsecutiveParseErrors(count: number): void {
		if (count >= 3) {
			this.debugLog('CHAT', 'Three consecutive parsing errors - failing');
			throw new Error('Failed to parse workflow code after 3 consecutive attempts.');
		}
	}

	/**
	 * Process a single iteration of the agentic loop
	 */
	private async *processIteration(params: {
		llmResult: { hasToolCalls: boolean; response: AIMessage };
		messages: BaseMessage[];
		currentWorkflow?: WorkflowJSON;
		textEditorEnabled: boolean;
		textEditorHandler?: TextEditorHandler;
		textEditorToolHandler?: TextEditorToolHandler;
		state: AgenticLoopState;
	}): AsyncGenerator<StreamOutput, { shouldBreak: boolean }, unknown> {
		const {
			llmResult,
			messages,
			currentWorkflow,
			textEditorEnabled,
			textEditorHandler,
			textEditorToolHandler,
			state,
		} = params;

		const response = llmResult.response;

		// Branch 1: Process tool calls
		if (llmResult.hasToolCalls && response.tool_calls) {
			return yield* this.handleToolCalls({
				toolCalls: response.tool_calls,
				messages,
				currentWorkflow,
				textEditorEnabled,
				textEditorHandler,
				textEditorToolHandler,
				state,
			});
		}

		// Branch 2: Text editor auto-finalize
		if (textEditorEnabled && textEditorHandler) {
			return yield* this.handleTextEditorAutoFinalize({
				textEditorHandler,
				currentWorkflow,
				messages,
				state,
			});
		}

		// Branch 3: Final response processing
		return await this.handleFinalResponse({
			response: llmResult.response,
			currentWorkflow,
			messages,
			state,
		});
	}

	/**
	 * Handle tool calls from LLM response
	 */
	private async *handleToolCalls(params: {
		toolCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
		messages: BaseMessage[];
		currentWorkflow?: WorkflowJSON;
		textEditorEnabled: boolean;
		textEditorHandler?: TextEditorHandler;
		textEditorToolHandler?: TextEditorToolHandler;
		state: AgenticLoopState;
	}): AsyncGenerator<StreamOutput, { shouldBreak: boolean }, unknown> {
		const {
			toolCalls,
			messages,
			currentWorkflow,
			textEditorEnabled,
			textEditorHandler,
			textEditorToolHandler,
			state,
		} = params;

		state.consecutiveParseErrors = 0;

		const dispatchResult = yield* this.toolDispatchHandler.dispatch({
			toolCalls,
			messages,
			currentWorkflow,
			iteration: state.iteration,
			textEditorHandler,
			textEditorToolHandler,
			warningTracker: state.warningTracker,
		});

		// Update state from dispatch result
		if (dispatchResult.workflow) {
			state.workflow = dispatchResult.workflow;
		}
		if (dispatchResult.parseDuration !== undefined) {
			state.parseDuration = dispatchResult.parseDuration;
		}
		if (dispatchResult.workflowReady) {
			state.sourceCode = dispatchResult.sourceCode ?? null;
			return { shouldBreak: true };
		}

		// Check if we should exit after text editor finalize
		if (textEditorEnabled && state.workflow && !dispatchResult.validatePassedThisIteration) {
			this.debugLog('CHAT', 'Workflow ready from text editor, exiting loop');
			if (this.evalLogger && textEditorHandler) {
				state.sourceCode = textEditorHandler.getWorkflowCode() ?? null;
			}
			return { shouldBreak: true };
		}

		// Track validate attempts
		if (dispatchResult.validatePassedThisIteration) {
			state.textEditorValidateAttempts++;
		}

		// Check for too many validate failures
		if (textEditorEnabled && state.textEditorValidateAttempts >= MAX_VALIDATE_ATTEMPTS) {
			throw new Error(
				`Failed to generate valid workflow after ${MAX_VALIDATE_ATTEMPTS} validate attempts.`,
			);
		}

		return { shouldBreak: false };
	}

	/**
	 * Handle text editor auto-finalize when no tool calls
	 */
	private async *handleTextEditorAutoFinalize(params: {
		textEditorHandler: TextEditorHandler;
		currentWorkflow?: WorkflowJSON;
		messages: BaseMessage[];
		state: AgenticLoopState;
	}): AsyncGenerator<StreamOutput, { shouldBreak: boolean }, unknown> {
		const { textEditorHandler, currentWorkflow, messages, state } = params;

		this.debugLog('CHAT', 'Text editor mode: no tool calls, auto-finalizing');
		state.textEditorValidateAttempts++;

		const autoFinalizeResult = yield* this.autoFinalizeHandler.execute({
			code: textEditorHandler.getWorkflowCode(),
			currentWorkflow,
			messages,
		});

		if (autoFinalizeResult.success && autoFinalizeResult.workflow) {
			state.workflow = autoFinalizeResult.workflow;
			state.parseDuration = autoFinalizeResult.parseDuration ?? 0;
			if (this.evalLogger) {
				state.sourceCode = textEditorHandler.getWorkflowCode() ?? null;
			}
			return { shouldBreak: true };
		}

		if (autoFinalizeResult.parseDuration) {
			state.parseDuration = autoFinalizeResult.parseDuration;
		}

		return { shouldBreak: false };
	}

	/**
	 * Handle final response when no tool calls (non-text-editor mode)
	 */
	private async handleFinalResponse(params: {
		response: AIMessage;
		currentWorkflow?: WorkflowJSON;
		messages: BaseMessage[];
		state: AgenticLoopState;
	}): Promise<{ shouldBreak: boolean }> {
		const { response, currentWorkflow, messages, state } = params;

		const finalResult = await this.finalResponseHandler.process({
			response,
			currentWorkflow,
			messages,
			warningTracker: state.warningTracker,
		});

		if (finalResult.parseDuration !== undefined) {
			state.parseDuration = finalResult.parseDuration;
		}
		if (finalResult.isParseError) {
			state.consecutiveParseErrors++;
		}

		if (finalResult.success && finalResult.workflow) {
			state.workflow = finalResult.workflow;
			if (this.evalLogger && finalResult.sourceCode) {
				state.sourceCode = finalResult.sourceCode;
			}
			return { shouldBreak: true };
		}

		return { shouldBreak: false };
	}
}

/**
 * Parameters for the agentic loop
 */
interface AgenticLoopParams {
	llmWithTools: LlmWithTools;
	messages: BaseMessage[];
	textEditorEnabled: boolean;
	currentWorkflow?: WorkflowJSON;
	textEditorHandler?: TextEditorHandler;
	textEditorToolHandler?: TextEditorToolHandler;
	abortSignal?: AbortSignal;
}

/**
 * Result of the agentic loop
 */
interface AgenticLoopResult {
	workflow: WorkflowJSON | null;
	parseDuration: number;
	sourceCode: string | null;
	iteration: number;
}

/**
 * Mutable state for the agentic loop
 */
interface AgenticLoopState {
	iteration: number;
	consecutiveParseErrors: number;
	workflow: WorkflowJSON | null;
	parseDuration: number;
	sourceCode: string | null;
	textEditorValidateAttempts: number;
	warningTracker: WarningTracker;
}
