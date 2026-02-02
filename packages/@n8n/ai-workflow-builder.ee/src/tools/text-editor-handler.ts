/**
 * Text Editor Handler
 *
 * Handles text editor tool commands for the code builder agent.
 * Implements the Anthropic str_replace_based_edit_tool interface for
 * managing workflow code as a virtual file (/workflow.ts).
 */

import type {
	TextEditorCommand,
	ViewCommand,
	CreateCommand,
	StrReplaceCommand,
	InsertCommand,
} from '../types/text-editor';
import {
	NoMatchFoundError,
	MultipleMatchesError,
	InvalidLineNumberError,
	InvalidPathError,
	FileNotFoundError,
} from '../types/text-editor';

/** The only supported file path for workflow code */
const WORKFLOW_FILE_PATH = '/workflow.ts';

/**
 * Format code with line numbers (matches view command output)
 *
 * @param code - The code to format
 * @returns Code with line numbers in "N: content" format
 */
export function formatCodeWithLineNumbers(code: string): string {
	const lines = code.split('\n');
	return lines.map((line, i) => `${i + 1}: ${line}`).join('\n');
}

/** Debug log callback type */
type DebugLogFn = (context: string, message: string, data?: Record<string, unknown>) => void;

/**
 * Handler for text editor tool commands
 *
 * Manages a single virtual file (/workflow.ts) containing workflow SDK code.
 * Supports view, create, str_replace, insert, and validate commands.
 */
export class TextEditorHandler {
	private code: string | null = null;
	private debugLog: DebugLogFn;

	constructor(debugLog?: DebugLogFn) {
		// Use provided debug log or no-op
		this.debugLog = debugLog ?? (() => {});
	}

	/**
	 * Execute a text editor command
	 *
	 * @param command - The command to execute
	 * @returns Result message for the LLM
	 * @throws Various errors for invalid operations
	 */
	execute(command: TextEditorCommand): string {
		this.debugLog('EXECUTE', `Executing command: ${command.command}`, {
			path: command.path,
			hasCode: this.code !== null,
			codeLength: this.code?.length ?? 0,
		});

		// Validate path for all commands
		this.validatePath(command.path);

		let result: string;
		switch (command.command) {
			case 'view':
				result = this.handleView(command);
				break;
			case 'create':
				result = this.handleCreate(command);
				break;
			case 'str_replace':
				result = this.handleStrReplace(command);
				break;
			case 'insert':
				result = this.handleInsert(command);
				break;
			case 'validate':
				// Validate is handled separately by the agent
				// This should not be called directly on execute
				result = 'Validate command should be handled by the agent.';
				break;
			default:
				result = `Unknown command: ${(command as { command: string }).command}`;
		}

		this.debugLog('EXECUTE', `Command ${command.command} completed`, {
			resultLength: result.length,
			newCodeLength: this.code?.length ?? 0,
		});

		return result;
	}

	/**
	 * Validate that the path is the supported workflow file
	 */
	private validatePath(path: string): void {
		if (path !== WORKFLOW_FILE_PATH) {
			throw new InvalidPathError(path);
		}
	}

	/**
	 * Handle view command - display file content with line numbers
	 */
	private handleView(command: ViewCommand): string {
		this.debugLog('VIEW', 'Handling view command', {
			hasViewRange: !!command.view_range,
			viewRange: command.view_range,
		});

		if (!this.code) {
			this.debugLog('VIEW', 'File not found - no code exists');
			throw new FileNotFoundError();
		}

		const lines = this.code.split('\n');
		this.debugLog('VIEW', 'File loaded', { totalLines: lines.length });

		// Handle view_range if specified
		if (command.view_range) {
			const [start, end] = command.view_range;

			// Validate range (1-indexed)
			if (start < 1 || end < start || start > lines.length) {
				this.debugLog('VIEW', 'Invalid line range', { start, end, totalLines: lines.length });
				throw new InvalidLineNumberError(start, lines.length);
			}

			// Convert to 0-indexed and extract range
			const startIdx = start - 1;
			const endIdx = Math.min(end, lines.length);
			const selectedLines = lines.slice(startIdx, endIdx);

			this.debugLog('VIEW', 'Returning range', {
				startLine: start,
				endLine: endIdx,
				linesReturned: selectedLines.length,
			});

			return selectedLines.map((line, i) => `${startIdx + i + 1}: ${line}`).join('\n');
		}

		this.debugLog('VIEW', 'Returning full file', { linesReturned: lines.length });
		// Return full file with line numbers
		return formatCodeWithLineNumbers(this.code);
	}

	/**
	 * Handle create command - rejected, workflow code is always pre-loaded
	 */
	private handleCreate(_command: CreateCommand): string {
		this.debugLog('CREATE', 'Create command rejected - workflow code is always pre-loaded');
		throw new Error(
			'The "create" command is not supported. ' +
				'Workflow code is pre-loaded. Use "view" to see current code, ' +
				'then "str_replace" to edit it.',
		);
	}

	/**
	 * Handle str_replace command - replace exact string match
	 */
	private handleStrReplace(command: StrReplaceCommand): string {
		this.debugLog('STR_REPLACE', 'Handling str_replace command', {
			oldStrLength: command.old_str.length,
			newStrLength: command.new_str.length,
			oldStrPreview: command.old_str.substring(0, 100),
			newStrPreview: command.new_str.substring(0, 100),
		});

		if (this.code === null) {
			this.debugLog('STR_REPLACE', 'File not found - no code exists');
			throw new FileNotFoundError();
		}

		const { old_str, new_str } = command;

		// Count occurrences
		const count = this.countOccurrences(this.code, old_str);
		this.debugLog('STR_REPLACE', 'Occurrence count', { count });

		if (count === 0) {
			this.debugLog('STR_REPLACE', 'No match found for replacement');
			throw new NoMatchFoundError(old_str);
		}

		if (count > 1) {
			this.debugLog('STR_REPLACE', 'Multiple matches found - cannot replace', { count });
			throw new MultipleMatchesError(count);
		}

		// Replace the single occurrence
		const oldCodeLength = this.code.length;
		this.code = this.code.replace(old_str, new_str);
		this.debugLog('STR_REPLACE', 'Edit applied successfully', {
			oldCodeLength,
			newCodeLength: this.code.length,
			sizeDelta: this.code.length - oldCodeLength,
		});
		return 'Edit applied successfully.';
	}

	/**
	 * Handle insert command - insert text at specific line
	 */
	private handleInsert(command: InsertCommand): string {
		this.debugLog('INSERT', 'Handling insert command', {
			insertLine: command.insert_line,
			newStrLength: command.new_str.length,
			newStrPreview: command.new_str.substring(0, 100),
		});

		if (this.code === null) {
			this.debugLog('INSERT', 'File not found - no code exists');
			throw new FileNotFoundError();
		}

		const { insert_line, new_str } = command;
		const lines = this.code.split('\n');

		// Validate line number (0 = beginning, 1-n = after that line)
		if (insert_line < 0 || insert_line > lines.length) {
			this.debugLog('INSERT', 'Invalid line number', {
				insertLine: insert_line,
				totalLines: lines.length,
			});
			throw new InvalidLineNumberError(insert_line, lines.length);
		}

		// Insert at the specified position
		const oldLineCount = lines.length;
		lines.splice(insert_line, 0, new_str);
		this.code = lines.join('\n');

		this.debugLog('INSERT', 'Text inserted successfully', {
			insertedAtLine: insert_line,
			oldLineCount,
			newLineCount: lines.length,
			newCodeLength: this.code.length,
		});

		return 'Text inserted successfully.';
	}

	/**
	 * Count non-overlapping occurrences of a substring
	 */
	private countOccurrences(text: string, search: string): number {
		if (search.length === 0) {
			return 0;
		}

		let count = 0;
		let pos = 0;

		while ((pos = text.indexOf(search, pos)) !== -1) {
			count++;
			pos += search.length;
		}

		return count;
	}

	/**
	 * Get the current workflow code
	 */
	getWorkflowCode(): string | null {
		this.debugLog('GET_CODE', 'Getting workflow code', {
			hasCode: this.code !== null,
			codeLength: this.code?.length ?? 0,
		});
		return this.code;
	}

	/**
	 * Set the workflow code (for pre-populating with existing workflow)
	 */
	setWorkflowCode(code: string): void {
		this.debugLog('SET_CODE', 'Setting workflow code', {
			codeLength: code.length,
			codeLines: code.split('\n').length,
		});
		this.code = code;
	}

	/**
	 * Check if workflow code exists
	 */
	hasWorkflowCode(): boolean {
		return this.code !== null;
	}

	/**
	 * Clear the workflow code
	 */
	clearWorkflowCode(): void {
		this.debugLog('CLEAR_CODE', 'Clearing workflow code', {
			hadCode: this.code !== null,
			previousLength: this.code?.length ?? 0,
		});
		this.code = null;
	}
}
