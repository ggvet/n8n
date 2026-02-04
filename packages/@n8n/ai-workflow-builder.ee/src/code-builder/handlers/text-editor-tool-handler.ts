/**
 * Text Editor Tool Handler
 *
 * Handles the str_replace_based_edit_tool execution. Wraps the TextEditorHandler
 * and adds progress streaming, auto-validation after create, and error handling.
 */

import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage, HumanMessage } from '@langchain/core/messages';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { StreamOutput, ToolProgressChunk } from '../../types/streaming';
import { FIX_AND_FINALIZE_INSTRUCTION } from '../constants';
import type { ParseAndValidateResult } from '../types';

/**
 * Debug log callback type
 */
type DebugLogFn = (context: string, message: string, data?: Record<string, unknown>) => void;

/**
 * Text editor execute function type
 */
type TextEditorExecuteFn = (args: Record<string, unknown>) => string;

/**
 * Text editor get code function type
 */
type TextEditorGetCodeFn = () => string | null;

/**
 * Parse and validate function type
 */
type ParseAndValidateFn = (
	code: string,
	currentWorkflow?: WorkflowJSON,
) => Promise<ParseAndValidateResult>;

/**
 * Get error context function type
 */
type GetErrorContextFn = (code: string, errorMessage: string) => string;

/**
 * Configuration for TextEditorToolHandler
 */
export interface TextEditorToolHandlerConfig {
	textEditorExecute: TextEditorExecuteFn;
	textEditorGetCode: TextEditorGetCodeFn;
	parseAndValidate: ParseAndValidateFn;
	getErrorContext: GetErrorContextFn;
	debugLog?: DebugLogFn;
}

/**
 * Parameters for executing the text editor tool
 */
export interface TextEditorToolParams {
	toolCallId: string;
	args: Record<string, unknown>;
	currentWorkflow: WorkflowJSON | undefined;
	iteration: number;
	messages: BaseMessage[];
}

/**
 * Result of text editor tool execution
 */
export interface TextEditorToolResult {
	workflowReady?: boolean;
	workflow?: WorkflowJSON;
}

/**
 * Handles the str_replace_based_edit_tool execution.
 *
 * This handler:
 * 1. Executes text editor commands (view, str_replace, create, insert)
 * 2. Auto-validates after create command
 * 3. Yields progress chunks
 * 4. Handles errors gracefully
 */
export class TextEditorToolHandler {
	private textEditorExecute: TextEditorExecuteFn;
	private textEditorGetCode: TextEditorGetCodeFn;
	private parseAndValidate: ParseAndValidateFn;
	private getErrorContext: GetErrorContextFn;
	private debugLog: DebugLogFn;

	constructor(config: TextEditorToolHandlerConfig) {
		this.textEditorExecute = config.textEditorExecute;
		this.textEditorGetCode = config.textEditorGetCode;
		this.parseAndValidate = config.parseAndValidate;
		this.getErrorContext = config.getErrorContext;
		this.debugLog = config.debugLog ?? (() => {});
	}

	/**
	 * Execute the text editor tool.
	 *
	 * @param params - Execution parameters
	 * @yields StreamOutput chunks for tool progress
	 * @returns TextEditorToolResult with optional workflowReady status
	 */
	async *execute(
		params: TextEditorToolParams,
	): AsyncGenerator<StreamOutput, TextEditorToolResult | undefined, unknown> {
		const { toolCallId, args, currentWorkflow, iteration, messages } = params;

		const command = args.command as string;
		this.debugLog('TEXT_EDITOR_TOOL', `Executing command: ${command}`, {
			iteration,
			toolCallId,
			command,
		});

		// Stream tool progress - running
		yield this.createToolProgressChunk('running', command);

		try {
			// Execute the text editor command
			const result = this.textEditorExecute(args);

			this.debugLog('TEXT_EDITOR_TOOL', `Command ${command} succeeded`, {
				resultLength: result.length,
			});

			// Add tool result to messages
			messages.push(
				new ToolMessage({
					tool_call_id: toolCallId,
					content: result,
				}),
			);

			// Auto-validate after create command
			if (command === 'create') {
				const autoValidateResult = await this.autoValidateAfterCreate(
					currentWorkflow,
					iteration,
					messages,
				);

				yield this.createToolProgressChunk('completed', command);
				return autoValidateResult;
			}

			yield this.createToolProgressChunk('completed', command);
			return undefined;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);

			this.debugLog('TEXT_EDITOR_TOOL', `Command ${command} failed`, {
				errorMessage,
			});

			// Add error message to messages
			messages.push(
				new ToolMessage({
					tool_call_id: toolCallId,
					content: `Error: ${errorMessage}`,
				}),
			);

			yield this.createToolProgressChunk('completed', command);
			return undefined;
		}
	}

	/**
	 * Auto-validate after create command
	 */
	private async autoValidateAfterCreate(
		currentWorkflow: WorkflowJSON | undefined,
		_iteration: number,
		messages: BaseMessage[],
	): Promise<TextEditorToolResult> {
		const code = this.textEditorGetCode();

		if (!code) {
			this.debugLog('TEXT_EDITOR_TOOL', 'Auto-validate: no code to validate');
			return { workflowReady: false };
		}

		this.debugLog('TEXT_EDITOR_TOOL', 'Auto-validating after create', {
			codeLength: code.length,
		});

		try {
			const result = await this.parseAndValidate(code, currentWorkflow);

			this.debugLog('TEXT_EDITOR_TOOL', 'Auto-validate succeeded', {
				warningCount: result.warnings.length,
				nodeCount: result.workflow.nodes.length,
			});

			// Handle warnings
			if (result.warnings.length > 0) {
				const warningText = result.warnings.map((w) => `- [${w.code}] ${w.message}`).join('\n');
				const errorContext = this.getErrorContext(code, result.warnings[0].message);

				// Add human message with warning feedback
				messages.push(
					new HumanMessage({
						content: `Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
					}),
				);

				return {
					workflowReady: false,
					workflow: result.workflow,
				};
			}

			// Validation passed
			return {
				workflowReady: true,
				workflow: result.workflow,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorContext = this.getErrorContext(code, errorMessage);

			this.debugLog('TEXT_EDITOR_TOOL', 'Auto-validate parse error', {
				errorMessage,
			});

			// Add human message with error feedback
			messages.push(
				new HumanMessage({
					content: `Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
				}),
			);

			return { workflowReady: false };
		}
	}

	/**
	 * Create a tool progress chunk
	 */
	private createToolProgressChunk(status: 'running' | 'completed', command: string): StreamOutput {
		return {
			messages: [
				{
					type: 'tool',
					toolName: 'str_replace_based_edit_tool',
					displayTitle: `Editing workflow (${command})`,
					status,
				} as ToolProgressChunk,
			],
		};
	}
}
