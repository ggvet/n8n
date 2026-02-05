/**
 * Tests for code-builder constants
 */

import {
	MAX_AGENT_ITERATIONS,
	MAX_VALIDATE_ATTEMPTS,
	FIX_AND_FINALIZE_INSTRUCTION,
	FIX_ISSUES_INSTRUCTION,
	TEXT_EDITOR_TOOL,
	VALIDATE_TOOL,
} from '../constants';

describe('code-builder constants', () => {
	describe('iteration limits', () => {
		it('should have MAX_AGENT_ITERATIONS set to 50', () => {
			expect(MAX_AGENT_ITERATIONS).toBe(50);
		});

		it('should have MAX_VALIDATE_ATTEMPTS set to 10', () => {
			expect(MAX_VALIDATE_ATTEMPTS).toBe(10);
		});
	});

	describe('FIX_ISSUES_INSTRUCTION', () => {
		it('should mention both str_replace and insert as fix options', () => {
			expect(FIX_ISSUES_INSTRUCTION).toContain('str_replace');
			expect(FIX_ISSUES_INSTRUCTION).toContain('insert');
		});
	});

	describe('FIX_AND_FINALIZE_INSTRUCTION', () => {
		it('should contain instruction to validate or stop calling tools', () => {
			expect(FIX_AND_FINALIZE_INSTRUCTION).toContain('validate_workflow');
			expect(FIX_AND_FINALIZE_INSTRUCTION).toContain('auto-finalize');
		});

		it('should use positive guardrail wording instead of negative', () => {
			expect(FIX_AND_FINALIZE_INSTRUCTION).not.toContain('Do NOT');
			expect(FIX_AND_FINALIZE_INSTRUCTION).not.toContain('Do not');
		});
	});

	describe('TEXT_EDITOR_TOOL', () => {
		it('should have correct type and name', () => {
			expect(TEXT_EDITOR_TOOL).toEqual({
				type: 'text_editor_20250728',
				name: 'str_replace_based_edit_tool',
			});
		});
	});

	describe('VALIDATE_TOOL', () => {
		it('should have correct function configuration', () => {
			expect(VALIDATE_TOOL.type).toBe('function');
			expect(VALIDATE_TOOL.function.name).toBe('validate_workflow');
			expect(VALIDATE_TOOL.function.description).toContain('Validate');
			expect(VALIDATE_TOOL.function.parameters.required).toContain('path');
		});
	});
});
