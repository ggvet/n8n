import { describe, it, expect } from '@jest/globals';
import {
	isMergeNamedInputSyntax,
	isSplitInBatchesBuilder,
	isSwitchCaseComposite,
	isIfElseComposite,
	isMergeComposite,
	isNodeInstanceShape,
} from './type-guards';

describe('workflow-builder/type-guards', () => {
	describe('isMergeNamedInputSyntax', () => {
		it('returns true for composite with _isNamedInputSyntax', () => {
			// Use type assertion to test with minimal mock object
			const composite = {
				mergeNode: {},
				branches: [],
				mode: 'combine',
				then: () => {},
				_isNamedInputSyntax: true,
			} as unknown as Parameters<typeof isMergeNamedInputSyntax>[0];
			expect(isMergeNamedInputSyntax(composite)).toBe(true);
		});

		it('returns false for composite without _isNamedInputSyntax', () => {
			const composite = {
				mergeNode: {},
				branches: [],
				mode: 'combine',
				then: () => {},
			} as unknown as Parameters<typeof isMergeNamedInputSyntax>[0];
			expect(isMergeNamedInputSyntax(composite)).toBe(false);
		});

		it('returns false for composite with _isNamedInputSyntax false', () => {
			const composite = {
				mergeNode: {},
				branches: [],
				mode: 'combine',
				then: () => {},
				_isNamedInputSyntax: false,
			} as unknown as Parameters<typeof isMergeNamedInputSyntax>[0];
			expect(isMergeNamedInputSyntax(composite)).toBe(false);
		});
	});

	describe('isSplitInBatchesBuilder', () => {
		it('returns true for direct builder', () => {
			const builder = {
				sibNode: {},
				_doneNodes: [],
				_eachNodes: [],
			};
			expect(isSplitInBatchesBuilder(builder)).toBe(true);
		});

		it('returns true for chain with builder parent', () => {
			const chain = {
				_parent: {
					sibNode: {},
					_doneNodes: [],
					_eachNodes: [],
				},
				_nodes: [],
			};
			expect(isSplitInBatchesBuilder(chain)).toBe(true);
		});

		it('returns false for null', () => {
			expect(isSplitInBatchesBuilder(null)).toBe(false);
		});

		it('returns false for non-object', () => {
			expect(isSplitInBatchesBuilder('string')).toBe(false);
		});

		it('returns false for regular object', () => {
			expect(isSplitInBatchesBuilder({ foo: 'bar' })).toBe(false);
		});
	});

	describe('isSwitchCaseComposite', () => {
		it('returns true for object with switchNode and cases', () => {
			const composite = { switchNode: {}, cases: [] };
			expect(isSwitchCaseComposite(composite)).toBe(true);
		});

		it('returns false for object missing switchNode', () => {
			expect(isSwitchCaseComposite({ cases: [] })).toBe(false);
		});

		it('returns false for object missing cases', () => {
			expect(isSwitchCaseComposite({ switchNode: {} })).toBe(false);
		});

		it('returns false for null', () => {
			expect(isSwitchCaseComposite(null)).toBe(false);
		});
	});

	describe('isIfElseComposite', () => {
		it('returns true for object with ifNode and trueBranch', () => {
			const composite = { ifNode: {}, trueBranch: {} };
			expect(isIfElseComposite(composite)).toBe(true);
		});

		it('returns false for object missing ifNode', () => {
			expect(isIfElseComposite({ trueBranch: {} })).toBe(false);
		});

		it('returns false for object missing trueBranch', () => {
			expect(isIfElseComposite({ ifNode: {} })).toBe(false);
		});

		it('returns false for null', () => {
			expect(isIfElseComposite(null)).toBe(false);
		});
	});

	describe('isMergeComposite', () => {
		it('returns true for object with mergeNode and branches', () => {
			const composite = { mergeNode: {}, branches: [] };
			expect(isMergeComposite(composite)).toBe(true);
		});

		it('returns false for object missing mergeNode', () => {
			expect(isMergeComposite({ branches: [] })).toBe(false);
		});

		it('returns false for object missing branches', () => {
			expect(isMergeComposite({ mergeNode: {} })).toBe(false);
		});

		it('returns false for null', () => {
			expect(isMergeComposite(null)).toBe(false);
		});
	});

	describe('isNodeInstanceShape', () => {
		it('returns true for object with required properties and then function', () => {
			const node = {
				type: 'test',
				version: 1,
				config: {},
				then: () => {},
			};
			expect(isNodeInstanceShape(node)).toBe(true);
		});

		it('returns false if then is not a function', () => {
			const node = {
				type: 'test',
				version: 1,
				config: {},
				then: 'not a function',
			};
			expect(isNodeInstanceShape(node)).toBe(false);
		});

		it('returns false for missing type', () => {
			const node = { version: 1, config: {}, then: () => {} };
			expect(isNodeInstanceShape(node)).toBe(false);
		});

		it('returns false for null', () => {
			expect(isNodeInstanceShape(null)).toBe(false);
		});
	});
});
