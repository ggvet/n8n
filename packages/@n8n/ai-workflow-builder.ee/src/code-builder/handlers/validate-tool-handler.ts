/**
 * Validate Tool Handler
 *
 * Handles the validate_workflow tool execution. Extracts the validation logic
 * from the code-builder-agent's executeValidateTool method.
 */

import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { StreamOutput, ToolProgressChunk, WorkflowUpdateChunk } from '../../types/streaming';
import { FIX_AND_FINALIZE_INSTRUCTION } from '../constants';
import type { WarningTracker } from '../state/warning-tracker';
import type { ParseAndValidateResult } from '../types';

/**
 * Debug log callback type
 */
type DebugLogFn = (context: string, message: string, data?: Record<string, unknown>) => void;

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
 * Configuration for ValidateToolHandler
 */
export interface ValidateToolHandlerConfig {
	parseAndValidate: ParseAndValidateFn;
	getErrorContext: GetErrorContextFn;
	debugLog?: DebugLogFn;
}

/**
 * Parameters for executing the validate tool
 */
export interface ValidateToolParams {
	toolCallId: string;
	code: string | null;
	currentWorkflow: WorkflowJSON | undefined;
	iteration: number;
	messages: BaseMessage[];
	warningTracker: WarningTracker;
}

/**
 * Result of validate tool execution
 */
export interface ValidateToolResult {
	workflowReady: boolean;
	workflow?: WorkflowJSON;
	parseDuration?: number;
}

/**
 * Handles the validate_workflow tool execution.
 *
 * This handler:
 * 1. Validates workflow code using parseAndValidate
 * 2. Tracks warnings and filters duplicates
 * 3. Yields progress and workflow update chunks
 * 4. Returns whether the workflow is ready
 */
export class ValidateToolHandler {
	private parseAndValidate: ParseAndValidateFn;
	private getErrorContext: GetErrorContextFn;
	private debugLog: DebugLogFn;

	constructor(config: ValidateToolHandlerConfig) {
		this.parseAndValidate = config.parseAndValidate;
		this.getErrorContext = config.getErrorContext;
		this.debugLog = config.debugLog ?? (() => {});
	}

	/**
	 * Execute the validate_workflow tool.
	 *
	 * @param params - Execution parameters
	 * @yields StreamOutput chunks for tool progress and workflow updates
	 * @returns ValidateToolResult with workflowReady status and optional workflow
	 */
	async *execute(
		params: ValidateToolParams,
	): AsyncGenerator<StreamOutput, ValidateToolResult, unknown> {
		const { toolCallId, code, currentWorkflow, iteration, messages, warningTracker } = params;

		this.debugLog('VALIDATE_TOOL', '========== VALIDATE ATTEMPT ==========', {
			iteration,
			toolCallId,
			hasCode: code !== null,
		});

		// Stream tool progress - running
		yield this.createToolProgressChunk('running');

		// Check if code exists
		if (!code) {
			this.debugLog('VALIDATE_TOOL', 'Validate failed: no code exists');
			messages.push(
				new ToolMessage({
					tool_call_id: toolCallId,
					content:
						'Error: No workflow code to validate. Use str_replace_based_edit_tool to add code first.',
				}),
			);
			yield this.createToolProgressChunk('completed');
			return { workflowReady: false };
		}

		this.debugLog('VALIDATE_TOOL', 'Validate: code to check', {
			codeLength: code.length,
			codeLines: code.split('\n').length,
		});

		const parseStartTime = Date.now();
		try {
			const result = await this.parseAndValidate(code, currentWorkflow);
			const parseDuration = Date.now() - parseStartTime;

			this.debugLog('VALIDATE_TOOL', 'Validate: parse completed', {
				parseDurationMs: parseDuration,
				warningCount: result.warnings.length,
				nodeCount: result.workflow.nodes.length,
			});

			// Handle warnings
			if (result.warnings.length > 0) {
				const newWarnings = warningTracker.filterNewWarnings(result.warnings);

				this.debugLog('VALIDATE_TOOL', 'Validate: validation warnings', {
					totalWarnings: result.warnings.length,
					newWarnings: newWarnings.length,
					repeatedWarnings: result.warnings.length - newWarnings.length,
				});

				if (newWarnings.length > 0) {
					// Track new warnings
					warningTracker.markAsSeen(newWarnings);

					const warningText = newWarnings.map((w) => `- [${w.code}] ${w.message}`).join('\n');
					const errorContext = this.getErrorContext(code, newWarnings[0].message);

					messages.push(
						new ToolMessage({
							tool_call_id: toolCallId,
							content: `Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace_based_edit_tool to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
						}),
					);

					// Stream partial workflow for progressive rendering
					yield this.createWorkflowUpdateChunk(result.workflow);
					yield this.createToolProgressChunk('completed');

					return {
						workflowReady: false,
						workflow: result.workflow,
						parseDuration,
					};
				}

				// All warnings are repeated - treat as success
				this.debugLog('VALIDATE_TOOL', 'All warnings are repeated, prompting agent to finalize');
			}

			// Validation passed
			messages.push(
				new ToolMessage({
					tool_call_id: toolCallId,
					content:
						'Validation passed. Workflow code is valid.\n\nIMPORTANT: Stop calling tools now to finalize the workflow.',
				}),
			);

			this.debugLog('VALIDATE_TOOL', '========== VALIDATE SUCCESS ==========', {
				nodeCount: result.workflow.nodes.length,
				nodeNames: result.workflow.nodes.map((n) => n.name),
			});

			// Stream workflow update
			yield this.createWorkflowUpdateChunk(result.workflow);
			yield this.createToolProgressChunk('completed');

			return {
				workflowReady: true,
				workflow: result.workflow,
				parseDuration,
			};
		} catch (error) {
			const parseDuration = Date.now() - parseStartTime;
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorContext = this.getErrorContext(code, errorMessage);

			this.debugLog('VALIDATE_TOOL', '========== VALIDATE FAILED ==========', {
				parseDurationMs: parseDuration,
				errorMessage,
			});

			messages.push(
				new ToolMessage({
					tool_call_id: toolCallId,
					content: `Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace_based_edit_tool to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
				}),
			);

			yield this.createToolProgressChunk('completed');

			return {
				workflowReady: false,
				parseDuration,
			};
		}
	}

	/**
	 * Create a tool progress chunk
	 */
	private createToolProgressChunk(status: 'running' | 'completed'): StreamOutput {
		return {
			messages: [
				{
					type: 'tool',
					toolName: 'validate_workflow',
					displayTitle: 'Validating workflow',
					status,
				} as ToolProgressChunk,
			],
		};
	}

	/**
	 * Create a workflow update chunk
	 */
	private createWorkflowUpdateChunk(workflow: WorkflowJSON): StreamOutput {
		return {
			messages: [
				{
					role: 'assistant',
					type: 'workflow-updated',
					codeSnippet: JSON.stringify(workflow, null, 2),
				} as WorkflowUpdateChunk,
			],
		};
	}
}
