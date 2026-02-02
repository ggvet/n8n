import type { ExpressionValue } from './types';

/**
 * Build a flat map of expression strings to formatted resolved values.
 * Used to annotate expressions in generated code with @example comments.
 */
export function buildExpressionAnnotations(
	expressionValues?: Record<string, ExpressionValue[]>,
): Map<string, string> {
	const annotations = new Map<string, string>();

	if (!expressionValues) return annotations;

	for (const expressions of Object.values(expressionValues)) {
		for (const { expression, resolvedValue } of expressions) {
			annotations.set(expression, formatResolvedValue(resolvedValue));
		}
	}

	return annotations;
}

function formatResolvedValue(value: unknown): string {
	if (value === undefined) {
		return 'undefined';
	}
	if (value === null) {
		return 'null';
	}
	if (typeof value === 'string') {
		const maxLen = 50;
		return value.length > maxLen ? `"${value.slice(0, maxLen)}..."` : `"${value}"`;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return `[Array with ${value.length} items]`;
	}
	return '[Object]';
}
