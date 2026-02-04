/**
 * Split In Batches Composite Handler Plugin
 *
 * Handles SplitInBatchesBuilder structures for processing data in batches.
 * This handles both:
 * - Named syntax: splitInBatches(sibNode, { done: ..., each: ... })
 * - Fluent API: splitInBatches(config).onDone(...).onEachBatch(...)
 */

import type { CompositeHandlerPlugin, MutablePluginContext } from '../types';
import type { NodeInstance, ConnectionTarget } from '../../types/base';

/**
 * A batch of nodes - either a single node or an array of nodes for fan-out
 */
type NodeBatch = NodeInstance<string, string, unknown> | NodeInstance<string, string, unknown>[];

/**
 * Shape of a SplitInBatchesBuilder for type checking
 * Supports both named syntax (_doneTarget/_eachTarget) and fluent API (_doneBatches/_eachBatches)
 */
interface SplitInBatchesBuilderShape {
	sibNode: NodeInstance<string, string, unknown>;
	_doneNodes: NodeInstance<string, string, unknown>[];
	_eachNodes: NodeInstance<string, string, unknown>[];
	// Named syntax targets
	_doneTarget?:
		| NodeInstance<string, string, unknown>
		| NodeInstance<string, string, unknown>[]
		| null;
	_eachTarget?:
		| NodeInstance<string, string, unknown>
		| NodeInstance<string, string, unknown>[]
		| null;
	// Fluent API batches
	_doneBatches?: NodeBatch[];
	_eachBatches?: NodeBatch[];
	_hasLoop?: boolean;
}

/**
 * Type guard for SplitInBatchesBuilder shape
 */
function isSplitInBatchesBuilderShape(value: unknown): value is SplitInBatchesBuilderShape {
	if (value === null || typeof value !== 'object') return false;

	// Check for required properties
	return 'sibNode' in value && '_doneNodes' in value && '_eachNodes' in value;
}

/**
 * Track SIB builders currently being processed to prevent infinite recursion.
 * This is used when onEachBatch chain loops back to the same SIB builder.
 */
const processingSibBuilders = new WeakSet<object>();

/**
 * Handler for Split In Batches composite structures.
 *
 * Recognizes SplitInBatchesBuilder patterns and adds the SIB node and its
 * done/each targets to the workflow graph.
 */
export const splitInBatchesHandler: CompositeHandlerPlugin<SplitInBatchesBuilderShape> = {
	id: 'core:split-in-batches',
	name: 'Split In Batches Handler',
	priority: 100,

	canHandle(input: unknown): input is SplitInBatchesBuilderShape {
		return isSplitInBatchesBuilderShape(input);
	},

	addNodes(input: SplitInBatchesBuilderShape, ctx: MutablePluginContext): string {
		// Check if we're already processing this builder (prevents infinite recursion)
		// This happens when onEachBatch chain loops back to the same SIB builder
		if (processingSibBuilders.has(input)) {
			return input.sibNode.name;
		}
		processingSibBuilders.add(input);

		try {
			// Check if this is named syntax (has _doneTarget/_eachTarget explicitly set)
			// Named syntax takes precedence over fluent API
			const hasNamedSyntax = '_doneTarget' in input || '_eachTarget' in input;

			if (hasNamedSyntax) {
				return processNamedSyntax(input, ctx);
			}

			// Check if this is fluent API (has _doneBatches/_eachBatches)
			const hasFluentApi =
				(input._doneBatches && input._doneBatches.length > 0) ||
				(input._eachBatches && input._eachBatches.length > 0);

			if (hasFluentApi) {
				return processFluentApi(input, ctx);
			}

			// No targets specified - just add the SIB node
			const sibConns = new Map<string, Map<number, ConnectionTarget[]>>();
			sibConns.set('main', new Map());
			ctx.nodes.set(input.sibNode.name, {
				instance: input.sibNode,
				connections: sibConns,
			});

			return input.sibNode.name;
		} finally {
			processingSibBuilders.delete(input);
		}
	},
};

/**
 * Process named syntax: splitInBatches(sibNode, { done: ..., each: ... })
 */
function processNamedSyntax(input: SplitInBatchesBuilderShape, ctx: MutablePluginContext): string {
	const sibMainConns = new Map<number, ConnectionTarget[]>();

	// Process done target (output 0)
	if (input._doneTarget !== null && input._doneTarget !== undefined) {
		const doneTarget = input._doneTarget;
		if (Array.isArray(doneTarget)) {
			// Fan-out: multiple targets from done output
			const targets: ConnectionTarget[] = [];
			for (const target of doneTarget) {
				const targetHead = ctx.addBranchToGraph(target);
				targets.push({ node: targetHead, type: 'main', index: 0 });
			}
			sibMainConns.set(0, targets);
		} else {
			const targetHead = ctx.addBranchToGraph(doneTarget);
			sibMainConns.set(0, [{ node: targetHead, type: 'main', index: 0 }]);
		}
	}

	// Process each target (output 1)
	if (input._eachTarget !== null && input._eachTarget !== undefined) {
		const eachTarget = input._eachTarget;
		if (Array.isArray(eachTarget)) {
			// Fan-out: multiple targets from each output
			const targets: ConnectionTarget[] = [];
			for (const target of eachTarget) {
				const targetHead = ctx.addBranchToGraph(target);
				targets.push({ node: targetHead, type: 'main', index: 0 });
			}
			sibMainConns.set(1, targets);
		} else {
			const targetHead = ctx.addBranchToGraph(eachTarget);
			sibMainConns.set(1, [{ node: targetHead, type: 'main', index: 0 }]);
		}
	}

	// Add the SIB node with connections
	const sibConns = new Map<string, Map<number, ConnectionTarget[]>>();
	sibConns.set('main', sibMainConns);
	ctx.nodes.set(input.sibNode.name, {
		instance: input.sibNode,
		connections: sibConns,
	});

	return input.sibNode.name;
}

/**
 * Process fluent API: splitInBatches(config).onDone(...).onEachBatch(...)
 */
function processFluentApi(input: SplitInBatchesBuilderShape, ctx: MutablePluginContext): string {
	const sibMainConns = new Map<number, ConnectionTarget[]>();

	// Process done chain batches (output 0)
	let prevDoneNode: string | null = null;
	for (const batch of input._doneBatches ?? []) {
		if (Array.isArray(batch)) {
			// Fan-out: all nodes in the array connect to the same source
			for (const doneNode of batch) {
				const firstNodeName = ctx.addBranchToGraph(doneNode);
				if (prevDoneNode === null) {
					// First batch connects to SIB output 0
					const output0 = sibMainConns.get(0) ?? [];
					sibMainConns.set(0, [...output0, { node: firstNodeName, type: 'main', index: 0 }]);
				} else {
					// Subsequent batches connect to previous node
					const prevGraphNode = ctx.nodes.get(prevDoneNode);
					if (prevGraphNode) {
						const prevMainConns = prevGraphNode.connections.get('main') ?? new Map();
						const existingConns = prevMainConns.get(0) ?? [];
						prevMainConns.set(0, [
							...existingConns,
							{ node: firstNodeName, type: 'main', index: 0 },
						]);
						prevGraphNode.connections.set('main', prevMainConns);
					}
				}
			}
		} else {
			const doneNode = batch;
			const firstNodeName = ctx.addBranchToGraph(doneNode);
			if (prevDoneNode === null) {
				// First batch connects to SIB output 0
				const output0 = sibMainConns.get(0) ?? [];
				sibMainConns.set(0, [...output0, { node: firstNodeName, type: 'main', index: 0 }]);
			} else {
				// Subsequent batches connect to previous node
				const prevGraphNode = ctx.nodes.get(prevDoneNode);
				if (prevGraphNode) {
					const prevMainConns = prevGraphNode.connections.get('main') ?? new Map();
					const existingConns = prevMainConns.get(0) ?? [];
					prevMainConns.set(0, [...existingConns, { node: firstNodeName, type: 'main', index: 0 }]);
					prevGraphNode.connections.set('main', prevMainConns);
				}
			}
			prevDoneNode = firstNodeName;
		}
	}

	// Process each chain batches (output 1)
	let prevEachNode: string | null = null;
	for (const batch of input._eachBatches ?? []) {
		if (Array.isArray(batch)) {
			// Fan-out: all nodes in the array connect to the same source
			for (const eachNode of batch) {
				const firstNodeName = ctx.addBranchToGraph(eachNode);
				if (prevEachNode === null) {
					// First batch connects to SIB output 1
					const output1 = sibMainConns.get(1) ?? [];
					sibMainConns.set(1, [...output1, { node: firstNodeName, type: 'main', index: 0 }]);
				} else {
					// Subsequent batches connect to previous node
					const prevGraphNode = ctx.nodes.get(prevEachNode);
					if (prevGraphNode) {
						const prevMainConns = prevGraphNode.connections.get('main') ?? new Map();
						const existingConns = prevMainConns.get(0) ?? [];
						prevMainConns.set(0, [
							...existingConns,
							{ node: firstNodeName, type: 'main', index: 0 },
						]);
						prevGraphNode.connections.set('main', prevMainConns);
					}
				}
			}
		} else {
			const eachNode = batch;
			const firstNodeName = ctx.addBranchToGraph(eachNode);
			if (prevEachNode === null) {
				// First batch connects to SIB output 1
				const output1 = sibMainConns.get(1) ?? [];
				sibMainConns.set(1, [...output1, { node: firstNodeName, type: 'main', index: 0 }]);
			} else {
				// Subsequent batches connect to previous node
				const prevGraphNode = ctx.nodes.get(prevEachNode);
				if (prevGraphNode) {
					const prevMainConns = prevGraphNode.connections.get('main') ?? new Map();
					const existingConns = prevMainConns.get(0) ?? [];
					prevMainConns.set(0, [...existingConns, { node: firstNodeName, type: 'main', index: 0 }]);
					prevGraphNode.connections.set('main', prevMainConns);
				}
			}
			prevEachNode = firstNodeName;
		}
	}

	// Add the SIB node with connections
	const sibConns = new Map<string, Map<number, ConnectionTarget[]>>();
	sibConns.set('main', sibMainConns);
	ctx.nodes.set(input.sibNode.name, {
		instance: input.sibNode,
		connections: sibConns,
	});

	// Add loop connection from last each node back to split in batches if hasLoop is true
	if (input._hasLoop && prevEachNode) {
		const lastEachGraphNode = ctx.nodes.get(prevEachNode);
		if (lastEachGraphNode) {
			const lastEachMainConns = lastEachGraphNode.connections.get('main') ?? new Map();
			const existingConns = lastEachMainConns.get(0) ?? [];
			lastEachMainConns.set(0, [
				...existingConns,
				{ node: input.sibNode.name, type: 'main', index: 0 },
			]);
			lastEachGraphNode.connections.set('main', lastEachMainConns);
		}
	}

	return input.sibNode.name;
}
