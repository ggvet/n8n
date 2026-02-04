/**
 * Evaluation Logger
 *
 * Centralized logger for capturing comprehensive debugging information during evaluations.
 * Accumulates all log entries and tool outputs for serialization to log.txt.
 *
 * When provided to the CodeWorkflowBuilder and passed through to agents:
 * - Captures all debugLog() output from orchestrator and agents
 * - Captures full tool call inputs and outputs with timing
 * - Preserves console output for dev experience
 */

import { inspect } from 'node:util';

interface LogEntry {
	timestamp: string;
	context: string;
	message: string;
	data?: unknown;
}

interface ToolCallEntry {
	timestamp: string;
	tool: string;
	input: unknown;
	output: string;
	durationMs: number;
}

interface WarningEntry {
	timestamp: string;
	context: string;
	warnings: Array<{ code: string; message: string; nodeName?: string }>;
}

interface ErrorEntry {
	timestamp: string;
	context: string;
	message: string;
	code?: string;
	stack?: string;
}

export class EvaluationLogger {
	private entries: LogEntry[] = [];
	private toolCalls: ToolCallEntry[] = [];
	private warnings: WarningEntry[] = [];
	private errors: ErrorEntry[] = [];

	/**
	 * Log a debug message - replaces console.log in debugLog() methods.
	 * Also outputs to console to preserve existing dev experience.
	 */
	log(context: string, message: string, data?: Record<string, unknown>): void {
		const timestamp = new Date().toISOString();
		this.entries.push({ timestamp, context, message, data });

		// Also output to console (preserves existing behavior)
		const prefix = `[${context}][${timestamp}]`;
		if (data) {
			const formatted = inspect(data, { depth: null, colors: true });
			console.log(`${prefix} ${message}\n${formatted}`);
		} else {
			console.log(`${prefix} ${message}`);
		}
	}

	/**
	 * Log a tool call with full input/output.
	 */
	logToolCall(tool: string, input: unknown, output: string, durationMs: number): void {
		const timestamp = new Date().toISOString();
		this.toolCalls.push({ timestamp, tool, input, output, durationMs });
	}

	/**
	 * Log validation warnings - uses console.warn for visibility.
	 */
	logWarnings(
		context: string,
		warnings: Array<{ code: string; message: string; nodeName?: string }>,
	): void {
		const timestamp = new Date().toISOString();
		this.warnings.push({ timestamp, context, warnings });

		// Output to console with warning level for visibility
		const prefix = `[${context}][${timestamp}]`;
		console.warn(`${prefix} Validation warnings (${warnings.length}):`);
		for (const w of warnings) {
			const nodeInfo = w.nodeName ? ` (node: ${w.nodeName})` : '';
			console.warn(`  - [${w.code}] ${w.message}${nodeInfo}`);
		}
	}

	/**
	 * Log an error - uses console.error for visibility.
	 */
	logError(context: string, message: string, code?: string, stack?: string): void {
		const timestamp = new Date().toISOString();
		this.errors.push({ timestamp, context, message, code, stack });

		// Output to console with error level for visibility
		const prefix = `[${context}][${timestamp}]`;
		console.error(`${prefix} ERROR: ${message}`);
		if (code) {
			console.error(`  Code snippet:\n${code.substring(0, 500)}${code.length > 500 ? '...' : ''}`);
		}
		if (stack) {
			console.error(`  Stack: ${stack}`);
		}
	}

	/**
	 * Serialize all logs for writing to log.txt.
	 */
	serialize(): string {
		const lines: string[] = [];

		lines.push('='.repeat(80));
		lines.push(`EVALUATION LOG - ${new Date().toISOString()}`);
		lines.push('='.repeat(80));
		lines.push('');

		// Log entries
		lines.push('[LOG ENTRIES]');
		lines.push('-'.repeat(80));
		for (const entry of this.entries) {
			const ts = entry.timestamp.split('T')[1]?.slice(0, 12) ?? entry.timestamp;
			lines.push(`[${ts}] [${entry.context}] ${entry.message}`);
			if (entry.data) {
				lines.push(inspect(entry.data, { depth: null, colors: false, breakLength: 120 }));
			}
		}
		lines.push('');

		// Tool calls with full output
		lines.push('[TOOL CALLS]');
		lines.push('-'.repeat(80));
		for (const call of this.toolCalls) {
			lines.push(`\n[TOOL: ${call.tool}] (${call.durationMs}ms)`);
			lines.push(`Input: ${JSON.stringify(call.input, null, 2)}`);
			lines.push(`Output:\n${call.output}`);
		}
		lines.push('');

		// Warnings section
		if (this.warnings.length > 0) {
			lines.push('[VALIDATION WARNINGS]');
			lines.push('-'.repeat(80));
			for (const entry of this.warnings) {
				const ts = entry.timestamp.split('T')[1]?.slice(0, 12) ?? entry.timestamp;
				lines.push(`\n[${ts}] [${entry.context}]`);
				for (const w of entry.warnings) {
					const nodeInfo = w.nodeName ? ` (node: ${w.nodeName})` : '';
					lines.push(`  - [${w.code}] ${w.message}${nodeInfo}`);
				}
			}
			lines.push('');
		}

		// Errors section
		if (this.errors.length > 0) {
			lines.push('[ERRORS]');
			lines.push('-'.repeat(80));
			for (const entry of this.errors) {
				const ts = entry.timestamp.split('T')[1]?.slice(0, 12) ?? entry.timestamp;
				lines.push(`\n[${ts}] [${entry.context}] ${entry.message}`);
				if (entry.code) {
					lines.push(`Code:\n${entry.code}`);
				}
				if (entry.stack) {
					lines.push(`Stack: ${entry.stack}`);
				}
			}
		}

		return lines.join('\n');
	}
}
