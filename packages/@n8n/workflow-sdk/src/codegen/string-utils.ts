/**
 * String utility functions for code generation
 */

/**
 * Escape a string for use in generated code
 * Uses unicode escape sequences to preserve special characters through roundtrip
 */
export function escapeString(str: string): string {
	return str
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\u2018/g, '\\u2018') // LEFT SINGLE QUOTATION MARK - preserve as unicode
		.replace(/\u2019/g, '\\u2019') // RIGHT SINGLE QUOTATION MARK - preserve as unicode
		.replace(/\u201C/g, '\\u201C') // LEFT DOUBLE QUOTATION MARK - preserve as unicode
		.replace(/\u201D/g, '\\u201D') // RIGHT DOUBLE QUOTATION MARK - preserve as unicode
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
}

/**
 * Check if a key needs to be quoted to be a valid JS identifier
 */
export function needsQuoting(key: string): boolean {
	// Valid JS identifier: starts with letter, _, or $, followed by letters, digits, _, or $
	return !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key);
}

/**
 * Format an object key for code output
 */
export function formatKey(key: string): string {
	return needsQuoting(key) ? `'${escapeString(key)}'` : key;
}

/**
 * Escape special regex characters in a string
 */
export function escapeRegexChars(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
