/**
 * Tool Dispatch Handler
 *
 * Handles the routing of tool calls to appropriate handlers during the chat loop.
 * Extracts tool call processing logic to reduce cyclomatic complexity in chat().
 */

import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { TextEditorHandler } from './text-editor-handler';
import type { TextEditorToolHandler } from './text-editor-tool-handler';
import type { ValidateToolHandler } from './validate-tool-handler';
import type { StreamOutput, ToolProgressChunk } from '../../types/streaming';
import type { WarningTracker } from '../state/warning-tracker';
import type { EvaluationLogger } from '../utils/evaluation-logger';

/**
 * Debug log callback type
 */
type DebugLogFn = (context: string, message: string, data?: Record<string, unknown>) => void;

/**
 * Tool call structure from LLM response
 */
export interface ToolCall {
	name: string;
	args: Record<string, unknown>;
	id?: string;
}

/**
 * Configuration for ToolDispatchHandler
 */
export interface ToolDispatchHandlerConfig {
	toolsMap: Map<string, StructuredToolInterface>;
	validateToolHandler: ValidateToolHandler;
	debugLog: DebugLogFn;
	evalLogger?: EvaluationLogger;
}

/**
 * Parameters for dispatching tool calls
 */
export interface ToolDispatchParams {
	toolCalls: ToolCall[];
	messages: BaseMessage[];
	currentWorkflow?: WorkflowJSON;
	iteration: number;
	textEditorHandler?: TextEditorHandler;
	textEditorToolHandler?: TextEditorToolHandler;
	warningTracker: WarningTracker;
}

/**
 * Result of tool dispatch
 */
export interface ToolDispatchResult {
	workflow?: WorkflowJSON;
	workflowReady: boolean;
	sourceCode?: string;
	parseDuration?: number;
	validatePassedThisIteration: boolean;
}

/**
 * Handles the routing of tool calls to appropriate handlers.
 *
 * This handler:
 * 1. Routes tool calls to appropriate handlers (text editor, validate, or general)
 * 2. Tracks workflow state updates from tool results
 * 3. Yields progress chunks for each tool call
 * 4. Returns aggregated result with workflow state
 */
export class ToolDispatchHandler {
	private toolsMap: Map<string, StructuredToolInterface>;
	private validateToolHandler: ValidateToolHandler;
	private debugLog: DebugLogFn;
	private evalLogger?: EvaluationLogger;

	constructor(config: ToolDispatchHandlerConfig) {
		this.toolsMap = config.toolsMap;
		this.validateToolHandler = config.validateToolHandler;
		this.debugLog = config.debugLog;
		this.evalLogger = config.evalLogger;
	}

	/**
	 * Dispatch tool calls to appropriate handlers.
	 *
	 * @param params - Dispatch parameters
	 * @yields StreamOutput chunks for tool progress
	 * @returns ToolDispatchResult with workflow state
	 */
	async *dispatch(
		params: ToolDispatchParams,
	): AsyncGenerator<StreamOutput, ToolDispatchResult, unknown> {
		const {
			toolCalls,
			messages,
			currentWorkflow,
			iteration,
			textEditorHandler,
			textEditorToolHandler,
			warningTracker,
		} = params;

		let workflow: WorkflowJSON | undefined;
		let workflowReady = false;
		let sourceCode: string | undefined;
		let parseDuration: number | undefined;
		let validatePassedThisIteration = false;

		this.debugLog('TOOL_DISPATCH', 'Processing tool calls...', {
			toolCalls: toolCalls.map((tc) => ({
				name: tc.name,
				id: tc.id ?? 'unknown',
			})),
		});

		for (const toolCall of toolCalls) {
			// Skip tool calls without an ID (shouldn't happen but handle gracefully)
			if (!toolCall.id) {
				this.debugLog('TOOL_DISPATCH', 'Skipping tool call without ID', { name: toolCall.name });
				continue;
			}

			const result = yield* this.executeToolCall({
				toolCall,
				messages,
				currentWorkflow,
				iteration,
				textEditorHandler,
				textEditorToolHandler,
				warningTracker,
			});

			// Update state from result
			if (result.workflow) {
				workflow = result.workflow;
			}
			if (result.parseDuration !== undefined) {
				parseDuration = result.parseDuration;
			}
			if (result.workflowReady) {
				workflowReady = true;
				// Capture source code for evaluations
				if (this.evalLogger && textEditorHandler) {
					sourceCode = textEditorHandler.getWorkflowCode() ?? undefined;
				}
				break;
			}
			if (result.validatePassed) {
				validatePassedThisIteration = true;
			}
		}

		return {
			workflow,
			workflowReady,
			sourceCode,
			parseDuration,
			validatePassedThisIteration,
		};
	}

	/**
	 * Execute a single tool call
	 */
	private async *executeToolCall(params: {
		toolCall: ToolCall;
		messages: BaseMessage[];
		currentWorkflow?: WorkflowJSON;
		iteration: number;
		textEditorHandler?: TextEditorHandler;
		textEditorToolHandler?: TextEditorToolHandler;
		warningTracker: WarningTracker;
	}): AsyncGenerator<
		StreamOutput,
		{
			workflow?: WorkflowJSON;
			workflowReady?: boolean;
			parseDuration?: number;
			validatePassed?: boolean;
		},
		unknown
	> {
		const {
			toolCall,
			messages,
			currentWorkflow,
			iteration,
			textEditorHandler,
			textEditorToolHandler,
			warningTracker,
		} = params;

		// Handle text editor tool calls
		if (toolCall.name === 'str_replace_based_edit_tool' && textEditorToolHandler) {
			const result = yield* textEditorToolHandler.execute({
				toolCallId: toolCall.id!,
				args: toolCall.args,
				currentWorkflow,
				iteration,
				messages,
			});

			if (result) {
				return {
					workflow: result.workflow,
					workflowReady: result.workflowReady,
				};
			}
			return {};
		}

		// Handle validate tool calls
		if (toolCall.name === 'validate_workflow' && textEditorToolHandler && textEditorHandler) {
			const result = yield* this.validateToolHandler.execute({
				toolCallId: toolCall.id!,
				code: textEditorHandler.getWorkflowCode(),
				currentWorkflow,
				iteration,
				messages,
				warningTracker,
			});

			return {
				workflow: result.workflow,
				workflowReady: result.workflowReady,
				parseDuration: result.parseDuration,
				validatePassed: result.workflowReady,
			};
		}

		// Execute other tools
		yield* this.executeGeneralToolCall(toolCall, messages);
		return {};
	}

	/**
	 * Execute a general tool call (not text editor or validate)
	 */
	private async *executeGeneralToolCall(
		toolCall: ToolCall,
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
					tool_call_id: toolCall.id!,
					content: errorMessage,
				}),
			);

			// Yield error status to update UI (was missing - tool left in 'running' state)
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
			return;
		}

		try {
			const toolStartTime = Date.now();
			const result: unknown = await tool.invoke(toolCall.args);
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
					tool_call_id: toolCall.id!,
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
			const errorStack = error instanceof Error ? error.stack : undefined;
			this.debugLog('TOOL_CALL', `Tool ${toolCall.name} failed`, {
				error: errorMessage,
				stack: errorStack,
			});

			messages.push(
				new ToolMessage({
					tool_call_id: toolCall.id!,
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
