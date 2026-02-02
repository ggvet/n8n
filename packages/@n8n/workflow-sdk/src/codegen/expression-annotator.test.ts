import { describe, it, expect } from '@jest/globals';
import { buildExpressionAnnotations } from './expression-annotator';
import type { ExpressionValue } from './types';

describe('expression-annotator', () => {
	describe('buildExpressionAnnotations', () => {
		it('builds map from expression values', () => {
			const expressionValues: Record<string, ExpressionValue[]> = {
				'Process User': [
					{ expression: '={{ $json.name }}', resolvedValue: 'John Doe' },
					{ expression: '={{ $json.id }}', resolvedValue: 123 },
				],
			};

			const result = buildExpressionAnnotations(expressionValues);

			expect(result.get('={{ $json.name }}')).toBe('"John Doe"');
			expect(result.get('={{ $json.id }}')).toBe('123');
		});

		it('truncates long string values', () => {
			const longValue = 'a'.repeat(60);
			const expressionValues: Record<string, ExpressionValue[]> = {
				Node: [{ expression: '={{ $json.data }}', resolvedValue: longValue }],
			};

			const result = buildExpressionAnnotations(expressionValues);

			expect(result.get('={{ $json.data }}')).toBe('"' + 'a'.repeat(50) + '..."');
		});

		it('handles boolean values', () => {
			const expressionValues: Record<string, ExpressionValue[]> = {
				Node: [{ expression: '={{ $json.active }}', resolvedValue: true }],
			};

			const result = buildExpressionAnnotations(expressionValues);

			expect(result.get('={{ $json.active }}')).toBe('true');
		});

		it('handles null and undefined values', () => {
			const expressionValues: Record<string, ExpressionValue[]> = {
				Node: [
					{ expression: '={{ $json.a }}', resolvedValue: null },
					{ expression: '={{ $json.b }}', resolvedValue: undefined },
				],
			};

			const result = buildExpressionAnnotations(expressionValues);

			expect(result.get('={{ $json.a }}')).toBe('null');
			expect(result.get('={{ $json.b }}')).toBe('undefined');
		});

		it('shows type hint for arrays', () => {
			const expressionValues: Record<string, ExpressionValue[]> = {
				Node: [{ expression: '={{ $json.items }}', resolvedValue: [1, 2, 3] }],
			};

			const result = buildExpressionAnnotations(expressionValues);

			expect(result.get('={{ $json.items }}')).toBe('[Array with 3 items]');
		});

		it('shows type hint for objects', () => {
			const expressionValues: Record<string, ExpressionValue[]> = {
				Node: [{ expression: '={{ $json.data }}', resolvedValue: { key: 'value' } }],
			};

			const result = buildExpressionAnnotations(expressionValues);

			expect(result.get('={{ $json.data }}')).toBe('[Object]');
		});

		it('returns empty map for undefined input', () => {
			const result = buildExpressionAnnotations(undefined);

			expect(result.size).toBe(0);
		});

		it('handles multiple nodes with expressions', () => {
			const expressionValues: Record<string, ExpressionValue[]> = {
				Node1: [{ expression: '={{ $json.a }}', resolvedValue: 'A' }],
				Node2: [{ expression: '={{ $json.b }}', resolvedValue: 'B' }],
			};

			const result = buildExpressionAnnotations(expressionValues);

			expect(result.get('={{ $json.a }}')).toBe('"A"');
			expect(result.get('={{ $json.b }}')).toBe('"B"');
		});
	});
});
