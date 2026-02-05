/**
 * Parse and Validate Handler
 *
 * Handles parsing TypeScript workflow code to WorkflowJSON and validation.
 * Consolidates duplicate parse/validate logic that was previously in multiple
 * places in the code builder agent.
 */

import type { Logger } from '@n8n/backend-common';
import { parseWorkflowCodeToBuilder, validateWorkflow } from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import { FIX_AND_FINALIZE_INSTRUCTION } from '../constants';
import type { ParseAndValidateResult, ValidationWarning } from '../types';
import { stripImportStatements } from '../utils/extract-code';

/**
 * Debug log callback type
 */
type DebugLogFn = (context: string, message: string, data?: Record<string, unknown>) => void;

/**
 * Configuration for ParseValidateHandler
 */
export interface ParseValidateHandlerConfig {
	debugLog?: DebugLogFn;
	logger?: Logger;
}

/**
 * Result of formatting validation feedback
 */
export interface ValidationFeedbackResult {
	feedbackMessage: string;
	hasWarnings: boolean;
}

/**
 * Result of formatting a parse error
 */
export interface ParseErrorResult {
	feedbackMessage: string;
}

/**
 * Handles parsing and validation of workflow code.
 *
 * Consolidates the parse/validate logic that was duplicated in:
 * - Main loop (lines 784-846)
 * - Text editor auto-finalize (lines 695-765)
 * - Validate tool (lines 1428-1594)
 */
export class ParseValidateHandler {
	private debugLog: DebugLogFn;
	private logger?: Logger;

	constructor(config: ParseValidateHandlerConfig = {}) {
		this.debugLog = config.debugLog ?? (() => {});
		this.logger = config.logger;
	}

	/**
	 * Parse TypeScript code to WorkflowJSON and validate.
	 *
	 * @param code - The TypeScript workflow code to parse
	 * @param currentWorkflow - Optional current workflow for context (used for pin data generation)
	 * @returns ParseAndValidateResult with workflow and any warnings
	 * @throws Error if parsing fails or there are validation errors
	 */
	async parseAndValidate(
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
		const codeToParse = stripImportStatements(code);
		this.debugLog('PARSE_VALIDATE', 'Code after stripping imports', {
			originalLength: code.length,
			strippedLength: codeToParse.length,
		});

		try {
			// Parse the TypeScript code to WorkflowBuilder
			this.logger?.debug('Parsing WorkflowCode', { codeLength: codeToParse.length });
			this.debugLog('PARSE_VALIDATE', 'Calling parseWorkflowCodeToBuilder...');
			const parseStartTime = Date.now();
			const builder = parseWorkflowCodeToBuilder(codeToParse);
			const parseDuration = Date.now() - parseStartTime;

			this.debugLog('PARSE_VALIDATE', 'Code parsed to builder', {
				parseDurationMs: parseDuration,
			});

			// Regenerate node IDs deterministically to ensure stable IDs across re-parses
			builder.regenerateNodeIds();
			this.debugLog('PARSE_VALIDATE', 'Node IDs regenerated deterministically');

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

			// Collect all validation issues (errors and warnings) for agent self-correction
			const allWarnings: ValidationWarning[] = [];

			// Collect graph validation errors as warnings for agent self-correction
			if (graphValidation.errors.length > 0) {
				this.debugLog('PARSE_VALIDATE', 'GRAPH VALIDATION ERRORS', {
					errors: graphValidation.errors.map((e: { message: string; code?: string }) => ({
						message: e.message,
						code: e.code,
					})),
				});
				this.logger?.warn('Graph validation errors', {
					errors: graphValidation.errors.map((e: { message: string }) => e.message),
				});
				for (const e of graphValidation.errors) {
					allWarnings.push({
						code: e.code,
						message: e.message,
						nodeName: e.nodeName,
					});
				}
			}

			// Collect graph validation warnings
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
				// Add JSON validation errors to allWarnings for agent self-correction
				for (const e of validationResult.errors) {
					allWarnings.push({
						code: e.code,
						message: e.message,
						nodeName: e.nodeName,
					});
				}
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
				code: code.substring(0, 500),
			});

			throw new Error(
				`Failed to parse generated workflow code: ${error instanceof Error ? error.message : 'Unknown error'}`,
			);
		}
	}

	/**
	 * Format validation warnings into feedback for the agent.
	 *
	 * @param result - The parse and validate result
	 * @param code - The original code for error context
	 * @returns Formatted feedback message
	 */
	formatValidationFeedback(result: ParseAndValidateResult, code: string): ValidationFeedbackResult {
		if (result.warnings.length === 0) {
			return { feedbackMessage: '', hasWarnings: false };
		}

		const warningText = result.warnings.map((w) => `- [${w.code}] ${w.message}`).join('\n');
		const errorContext = this.getErrorContext(code, result.warnings[0].message);

		return {
			feedbackMessage: `Validation warnings:\n${warningText}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
			hasWarnings: true,
		};
	}

	/**
	 * Format a parse error into feedback for the agent.
	 *
	 * @param error - The parse error
	 * @param code - The original code for error context
	 * @returns Formatted feedback message
	 */
	formatParseError(error: Error, code: string): ParseErrorResult {
		const errorMessage = error.message;
		const errorContext = this.getErrorContext(code, errorMessage);

		return {
			feedbackMessage: `Parse error: ${errorMessage}\n\n${errorContext}\n\nUse str_replace to fix these issues.${FIX_AND_FINALIZE_INSTRUCTION}`,
		};
	}

	/**
	 * Extract error context with line numbers for debugging.
	 *
	 * @param code - The code to extract context from
	 * @param errorMessage - The error message (may contain line number)
	 * @returns Formatted code context around the error
	 */
	getErrorContext(code: string, errorMessage: string): string {
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
}
