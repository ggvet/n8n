/**
 * Auto-Finalize Handler
 *
 * Handles the auto-finalize logic when the LLM stops calling tools in text editor mode.
 * Validates the code and either returns success or provides feedback for correction.
 */

import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { StreamOutput } from '../../types/streaming';
import { FIX_AND_FINALIZE_INSTRUCTION } from '../constants';
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
 * Configuration for AutoFinalizeHandler
 */
export interface AutoFinalizeHandlerConfig {
	parseAndValidate: ParseAndValidateFn;
	getErrorContext: GetErrorContextFn;
	debugLog?: DebugLogFn;
}

/**
 * Parameters for executing auto-finalize
 */
export interface AutoFinalizeParams {
	/** The current workflow code from text editor (null if no code yet) */
	code: string | null;
	/** The current workflow context for validation */
	currentWorkflow: WorkflowJSON | undefined;
	/** Message history to append feedback to */
	messages: BaseMessage[];
}

/**
 * Result of auto-finalize execution
 */
export interface AutoFinalizeResult {
	/** Whether auto-finalize succeeded */
	success: boolean;
	/** Whether we prompted for code creation (no code existed) */
	promptedForCode?: boolean;
	/** The validated workflow (only on success) */
	workflow?: WorkflowJSON;
	/** Parse duration in milliseconds */
	parseDuration?: number;
}

/**
 * Handles the auto-finalize logic when the LLM stops calling tools.
 *
 * This handler:
 * 1. Prompts for code creation if no code exists
 * 2. Validates the code and returns success on valid workflow
 * 3. Provides feedback for warnings or parse errors
 */
export class AutoFinalizeHandler {
	private parseAndValidate: ParseAndValidateFn;
	private getErrorContext: GetErrorContextFn;
	private debugLog: DebugLogFn;

	constructor(config: AutoFinalizeHandlerConfig) {
		this.parseAndValidate = config.parseAndValidate;
		this.getErrorContext = config.getErrorContext;
		this.debugLog = config.debugLog ?? (() => {});
	}

	/**
	 * Execute the auto-finalize logic.
	 *
	 * @param params - Execution parameters
	 * @yields StreamOutput chunks (currently none, but kept for consistency)
	 * @returns AutoFinalizeResult with success status and optional workflow
	 */
	// eslint-disable-next-line require-yield
	async *execute(
		params: AutoFinalizeParams,
	): AsyncGenerator<StreamOutput, AutoFinalizeResult, unknown> {
		const { code, currentWorkflow, messages } = params;

		// No code yet - prompt to create
		if (!code) {
			this.debugLog('AUTO_FINALIZE', 'No code exists, prompting to create');
			messages.push(
				new HumanMessage('Please use the text editor tool to create or edit the workflow code.'),
			);
			return { success: false, promptedForCode: true };
		}

		// Auto-validate and finalize
		this.debugLog('AUTO_FINALIZE', '========== AUTO-FINALIZE (NO TOOL CALLS) ==========', {
			codeLength: code.length,
		});

		const parseStartTime = Date.now();
		try {
			const result = await this.parseAndValidate(code, currentWorkflow);
			const parseDuration = Date.now() - parseStartTime;

			this.debugLog('AUTO_FINALIZE', 'Parse completed', {
				parseDurationMs: parseDuration,
				warningCount: result.warnings.length,
				nodeCount: result.workflow.nodes.length,
			});

			// Handle warnings
			if (result.warnings.length > 0) {
				const warningText = result.warnings.map((w) => `- [${w.code}] ${w.message}`).join('\n');
				const errorContext = this.getErrorContext(code, result.warnings[0].message);

				this.debugLog('AUTO_FINALIZE', 'Validation warnings', {
					warnings: result.warnings,
				});

				// Send warnings back to agent for correction
				messages.push(
					new HumanMessage(
						`Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
					),
				);

				return { success: false, parseDuration };
			}

			// Success - workflow validated
			this.debugLog('AUTO_FINALIZE', '========== AUTO-FINALIZE SUCCESS ==========', {
				nodeCount: result.workflow.nodes.length,
				nodeNames: result.workflow.nodes.map((n) => n.name),
			});

			return {
				success: true,
				workflow: result.workflow,
				parseDuration,
			};
		} catch (error) {
			const parseDuration = Date.now() - parseStartTime;
			const errorMessage = error instanceof Error ? error.message : String(error);
			const errorContext = this.getErrorContext(code, errorMessage);

			this.debugLog('AUTO_FINALIZE', '========== AUTO-FINALIZE FAILED ==========', {
				parseDurationMs: parseDuration,
				errorMessage,
			});

			// Send error back to agent for correction
			messages.push(
				new HumanMessage(
					`Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
				),
			);

			return { success: false, parseDuration };
		}
	}
}
