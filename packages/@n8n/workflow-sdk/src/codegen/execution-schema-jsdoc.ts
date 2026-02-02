import type { Schema } from 'n8n-workflow';

/**
 * Generate JSDoc comment content with output schema for a node.
 * No TypeScript generics - parser doesn't support them.
 */
export function generateSchemaJSDoc(nodeName: string, schema: Schema): string {
	const lines: string[] = [];
	lines.push(`@output - access via $('${nodeName}').item.json`);

	if (schema.type === 'object' && Array.isArray(schema.value)) {
		for (const field of schema.value) {
			const tsType = schemaTypeToTs(field.type);
			const example =
				typeof field.value === 'string' ? `  // @example ${formatSampleValue(field.value)}` : '';
			lines.push(`  ${field.key}: ${tsType}${example}`);
		}
	}

	return lines.join('\n');
}

function schemaTypeToTs(type: string): string {
	const typeMap: Record<string, string> = {
		string: 'string',
		number: 'number',
		boolean: 'boolean',
		object: 'Record<string, unknown>',
		array: 'unknown[]',
		null: 'null',
		undefined: 'undefined',
	};
	return typeMap[type] ?? 'unknown';
}

function formatSampleValue(value: string): string {
	const maxLen = 40;
	const escaped = value.replace(/\n/g, '\\n');
	return escaped.length > maxLen ? `"${escaped.slice(0, maxLen)}..."` : `"${escaped}"`;
}
