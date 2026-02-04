/**
 * Final Response Handler
 *
 * Handles parsing and validating the final response when the LLM stops making tool calls.
 * Extracts workflow code from the response and validates it, providing feedback for corrections.
 */

import type { BaseMessage, AIMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { WarningTracker } from '../state/warning-tracker';
import type { ParseAndValidateResult, WorkflowCodeOutput, ValidationWarning } from '../types';
import { extractTextContent } from '../utils/content-extractors';
import { extractWorkflowCode } from '../utils/extract-code';

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
 * Evaluation logger interface (subset of what we need)
 */
interface EvalLoggerInterface {
	logWarnings: (context: string, warnings: ValidationWarning[]) => void;
	logError: (context: string, message: string, code?: string, stack?: string) => void;
}

/**
 * Configuration for FinalResponseHandler
 */
export interface FinalResponseHandlerConfig {
	parseAndValidate: ParseAndValidateFn;
	debugLog?: DebugLogFn;
	evalLogger?: EvalLoggerInterface;
}

/**
 * Parameters for processing the final response
 */
export interface FinalResponseParams {
	/** The LLM response to parse */
	response: AIMessage;
	/** Current workflow context for validation */
	currentWorkflow: WorkflowJSON | undefined;
	/** Message history to append feedback to */
	messages: BaseMessage[];
	/** Warning tracker for deduplication */
	warningTracker: WarningTracker;
}

/**
 * Result of final response processing
 */
export interface FinalResponseResult {
	/** Whether processing succeeded (workflow is ready) */
	success: boolean;
	/** The validated workflow (only on success) */
	workflow?: WorkflowJSON;
	/** The source code (only on success) */
	sourceCode?: string;
	/** Parse duration in milliseconds */
	parseDuration?: number;
	/** Whether this was a parse error (should increment consecutiveParseErrors) */
	isParseError?: boolean;
	/** Whether the loop should continue (for warnings/errors that got feedback) */
	shouldContinue?: boolean;
}

/**
 * Handles the final response when the LLM stops making tool calls.
 *
 * This handler:
 * 1. Parses structured output (TypeScript code blocks) from the response
 * 2. Validates the workflow code
 * 3. Handles warnings by providing feedback to the agent
 * 4. Returns whether the workflow is ready or needs correction
 */
export class FinalResponseHandler {
	private parseAndValidate: ParseAndValidateFn;
	private debugLog: DebugLogFn;
	private evalLogger?: EvalLoggerInterface;

	constructor(config: FinalResponseHandlerConfig) {
		this.parseAndValidate = config.parseAndValidate;
		this.debugLog = config.debugLog ?? (() => {});
		this.evalLogger = config.evalLogger;
	}

	/**
	 * Process the final response from the LLM.
	 *
	 * @param params - Processing parameters
	 * @returns FinalResponseResult with success status and optional workflow
	 */
	async process(params: FinalResponseParams): Promise<FinalResponseResult> {
		const { response, currentWorkflow, messages, warningTracker } = params;

		this.debugLog('FINAL_RESPONSE', 'Processing final response (no tool calls)');

		// Parse structured output from response
		const parseResult = this.parseStructuredOutput(response);

		if (!parseResult.result) {
			this.debugLog('FINAL_RESPONSE', 'Could not parse structured output', {
				error: parseResult.error,
			});

			// Add follow-up message with error
			messages.push(
				new HumanMessage(
					`Could not parse your response: ${parseResult.error}\n\nPlease provide your workflow code in a \`\`\`typescript code block.`,
				),
			);

			return {
				success: false,
				isParseError: true,
				shouldContinue: true,
			};
		}

		const workflowCode = parseResult.result.workflowCode;
		this.debugLog('FINAL_RESPONSE', 'Parsed workflow code from response', {
			codeLength: workflowCode.length,
		});

		// Try to parse and validate the workflow code
		const parseStartTime = Date.now();

		try {
			const result = await this.parseAndValidate(workflowCode, currentWorkflow);
			const parseDuration = Date.now() - parseStartTime;

			this.debugLog('FINAL_RESPONSE', 'Workflow parsed and validated', {
				parseDurationMs: parseDuration,
				workflowId: result.workflow.id,
				nodeCount: result.workflow.nodes.length,
				warningCount: result.warnings.length,
			});

			// Check for new warnings
			const newWarnings = warningTracker.filterNewWarnings(result.warnings);

			if (newWarnings.length > 0) {
				this.debugLog('FINAL_RESPONSE', 'New validation warnings found', {
					newWarningCount: newWarnings.length,
				});

				// Mark warnings as seen
				warningTracker.markAsSeen(newWarnings);

				// Format warnings
				const warningMessages = newWarnings
					.slice(0, 5)
					.map((w) => `- [${w.code}] ${w.message}`)
					.join('\n');

				// Log warnings
				this.evalLogger?.logWarnings('CODE-BUILDER:VALIDATION', newWarnings);

				// Send feedback to agent
				messages.push(
					new HumanMessage(
						`The workflow code has validation warnings that should be addressed:\n\n${warningMessages}\n\nPlease fix these issues and provide the corrected version in a \`\`\`typescript code block.`,
					),
				);

				return {
					success: false,
					parseDuration,
					shouldContinue: true,
				};
			}

			// Success - no new warnings
			this.debugLog('FINAL_RESPONSE', 'No new warnings, workflow ready');

			return {
				success: true,
				workflow: result.workflow,
				sourceCode: workflowCode,
				parseDuration,
				shouldContinue: false,
			};
		} catch (parseError) {
			const parseDuration = Date.now() - parseStartTime;
			const errorMessage = parseError instanceof Error ? parseError.message : String(parseError);
			const errorStack = parseError instanceof Error ? parseError.stack : undefined;

			this.debugLog('FINAL_RESPONSE', 'Workflow parsing failed', {
				parseDurationMs: parseDuration,
				errorMessage,
			});

			// Log error
			this.evalLogger?.logError('CODE-BUILDER:PARSE', errorMessage, undefined, errorStack);

			// Send feedback to agent
			messages.push(
				new HumanMessage(
					`The workflow code you generated has a parsing error:\n\n${errorMessage}\n\nPlease fix the code and provide the corrected version in a \`\`\`typescript code block.`,
				),
			);

			return {
				success: false,
				parseDuration,
				isParseError: true,
				shouldContinue: true,
			};
		}
	}

	/**
	 * Parse structured output from an AI message.
	 * Extracts workflow code from TypeScript code blocks.
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
		});

		// Extract code from TypeScript code blocks
		const workflowCode = extractWorkflowCode(content);

		// Check if we got valid code
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
