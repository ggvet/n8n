/**
 * Type guard functions for workflow builder composites and builders
 */

import type { MergeComposite, NodeInstance } from '../types/base';

/**
 * Type guard to check if a MergeComposite uses the old named input syntax.
 * This is for backward compatibility with code using the old merge(node, { input0: ..., input1: ... }) syntax.
 * New code should use the merge() factory and .input(n) syntax instead.
 */
export function isMergeNamedInputSyntax(
	composite: MergeComposite<NodeInstance<string, string, unknown>[]>,
): boolean {
	return '_isNamedInputSyntax' in composite && composite._isNamedInputSyntax === true;
}

/**
 * Check if value is a SplitInBatchesBuilder or a chain (DoneChain/EachChain) from one
 */
export function isSplitInBatchesBuilder(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;

	// Direct builder check
	if ('sibNode' in value && '_doneNodes' in value && '_eachNodes' in value) {
		return true;
	}

	// Check if it's a DoneChain or EachChain with a _parent that's a builder
	if ('_parent' in value && '_nodes' in value) {
		const parent = (value as { _parent: unknown })._parent;
		return (
			parent !== null &&
			typeof parent === 'object' &&
			'sibNode' in parent &&
			'_doneNodes' in parent &&
			'_eachNodes' in parent
		);
	}

	return false;
}

/**
 * SplitInBatchesBuilder shape for extraction
 */
export interface SplitInBatchesBuilderShape {
	sibNode: NodeInstance<'n8n-nodes-base.splitInBatches', string, unknown>;
	_doneNodes: NodeInstance<string, string, unknown>[];
	_eachNodes: NodeInstance<string, string, unknown>[];
	_doneBatches: Array<
		NodeInstance<string, string, unknown> | NodeInstance<string, string, unknown>[]
	>;
	_eachBatches: Array<
		NodeInstance<string, string, unknown> | NodeInstance<string, string, unknown>[]
	>;
	_hasLoop: boolean;
	// Named syntax properties (optional - only present for splitInBatches(node, { done, each }))
	_doneTarget?: unknown;
	_eachTarget?: unknown;
}

/**
 * Extract the SplitInBatchesBuilder from a value (handles both direct builder and chains)
 */
export function extractSplitInBatchesBuilder(value: unknown): SplitInBatchesBuilderShape {
	// Direct builder
	if ('sibNode' in (value as object)) {
		return value as SplitInBatchesBuilderShape;
	}

	// Chain with _parent - extract the parent builder
	const chain = value as { _parent: unknown };
	return chain._parent as SplitInBatchesBuilderShape;
}

/**
 * Check if value is a SwitchCaseComposite
 */
export function isSwitchCaseComposite(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	return 'switchNode' in value && 'cases' in value;
}

/**
 * Check if value is an IfElseComposite
 */
export function isIfElseComposite(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	return 'ifNode' in value && 'trueBranch' in value;
}

/**
 * Check if value is a MergeComposite
 */
export function isMergeComposite(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	return 'mergeNode' in value && 'branches' in value;
}

/**
 * Check if value has the shape of a NodeInstance (has type, version, config, then method)
 * Renamed to avoid conflict with similar checks that use different criteria
 */
export function isNodeInstanceShape(value: unknown): boolean {
	if (value === null || typeof value !== 'object') return false;
	return (
		'type' in value &&
		'version' in value &&
		'config' in value &&
		'then' in value &&
		typeof (value as NodeInstance<string, string, unknown>).then === 'function'
	);
}
