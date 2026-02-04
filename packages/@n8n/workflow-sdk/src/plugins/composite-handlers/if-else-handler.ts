/**
 * If/Else Composite Handler Plugin
 *
 * Handles IfElseComposite and IfElseBuilder structures - if/else branching patterns.
 */

import type { CompositeHandlerPlugin, MutablePluginContext } from '../types';
import type {
	IfElseComposite,
	ConnectionTarget,
	NodeInstance,
	IfElseBuilder,
	SwitchCaseComposite,
	NodeChain,
	SwitchCaseBuilder,
} from '../../types/base';
import { isNodeChain } from '../../types/base';
import {
	isIfElseComposite,
	isSwitchCaseComposite,
	isSplitInBatchesBuilder,
	extractSplitInBatchesBuilder,
} from '../../workflow-builder/type-guards';
import { isIfElseBuilder, isSwitchCaseBuilder } from '../../node-builder';

/**
 * Type representing either Composite or Builder format
 */
type IfElseInput = IfElseComposite | IfElseBuilder<unknown>;

/**
 * Get the head node name from a target (which could be a node, chain, or composite)
 * This is used to compute connection target names BEFORE adding nodes.
 */
function getTargetNodeName(target: unknown): string | undefined {
	if (target === null || target === undefined) return undefined;

	// Handle NodeChain
	if (isNodeChain(target)) {
		return (target as NodeChain).head.name;
	}

	// Handle composites
	if (isIfElseComposite(target)) {
		return (target as IfElseComposite).ifNode.name;
	}

	if (isSwitchCaseComposite(target)) {
		return (target as SwitchCaseComposite).switchNode.name;
	}

	// Handle IfElseBuilder (fluent API)
	if (isIfElseBuilder(target)) {
		return (target as IfElseBuilder<unknown>).ifNode.name;
	}

	// Handle SwitchCaseBuilder (fluent API)
	if (isSwitchCaseBuilder(target)) {
		return (target as SwitchCaseBuilder<unknown>).switchNode.name;
	}

	// Handle SplitInBatchesBuilder (including EachChain/DoneChain)
	if (isSplitInBatchesBuilder(target)) {
		const builder = extractSplitInBatchesBuilder(target);
		return builder.sibNode.name;
	}

	// Regular NodeInstance
	if (typeof (target as NodeInstance<string, string, unknown>).name === 'string') {
		return (target as NodeInstance<string, string, unknown>).name;
	}

	return undefined;
}

/**
 * Helper to collect nodes from a branch for pin data gathering.
 * Handles null, single nodes, and arrays.
 */
function collectFromBranch(
	branch: unknown,
	collector: (node: NodeInstance<string, string, unknown>) => void,
): void {
	if (branch === null || branch === undefined) return;
	if (Array.isArray(branch)) {
		for (const n of branch) {
			if (n !== null && n !== undefined) {
				collector(n as NodeInstance<string, string, unknown>);
			}
		}
	} else {
		collector(branch as NodeInstance<string, string, unknown>);
	}
}

/**
 * Add nodes from a branch target to the nodes map, recursively handling nested composites.
 * This is used for IfElseBuilder to add branch nodes AFTER setting up IF connections.
 */
function addBranchTargetNodes(target: unknown, ctx: MutablePluginContext): void {
	if (target === null || target === undefined) return;

	// Handle array (fan-out) - process each target
	if (Array.isArray(target)) {
		for (const t of target) {
			addBranchTargetNodes(t, ctx);
		}
		return;
	}

	// Add the branch using the context's addBranchToGraph method
	ctx.addBranchToGraph(target);
}

/**
 * Helper to process a branch for IfElseComposite (add nodes first, then use results for connections)
 */
function processBranchForComposite(
	branch: unknown,
	outputIndex: number,
	ctx: MutablePluginContext,
	ifMainConns: Map<number, ConnectionTarget[]>,
): void {
	if (branch === null || branch === undefined) {
		return; // Skip null branches - no connection for this output
	}

	// Check if branch is an array (fan-out pattern)
	if (Array.isArray(branch)) {
		// Fan-out: multiple parallel targets from this branch
		const targets: ConnectionTarget[] = [];
		for (const branchNode of branch as (NodeInstance<string, string, unknown> | null)[]) {
			if (branchNode === null) continue;
			const branchHead = ctx.addBranchToGraph(branchNode);
			targets.push({ node: branchHead, type: 'main', index: 0 });
		}
		if (targets.length > 0) {
			ifMainConns.set(outputIndex, targets);
		}
	} else {
		const branchHead = ctx.addBranchToGraph(branch);
		ifMainConns.set(outputIndex, [{ node: branchHead, type: 'main', index: 0 }]);
	}
}

/**
 * Process a branch for IfElseBuilder - compute target names BEFORE adding nodes
 */
function processBranchForBuilder(
	branch: unknown,
	outputIndex: number,
	_ifNode: NodeInstance<string, string, unknown>,
	ifMainConns: Map<number, ConnectionTarget[]>,
): void {
	if (branch === null || branch === undefined) {
		return;
	}

	if (Array.isArray(branch)) {
		const targets: ConnectionTarget[] = [];
		for (const t of branch) {
			const targetName = getTargetNodeName(t);
			if (targetName) {
				targets.push({ node: targetName, type: 'main', index: 0 });
			}
		}
		if (targets.length > 0) {
			ifMainConns.set(outputIndex, targets);
		}
	} else {
		const targetName = getTargetNodeName(branch);
		if (targetName) {
			ifMainConns.set(outputIndex, [{ node: targetName, type: 'main', index: 0 }]);
		}
	}
}

/**
 * Handler for If/Else composite structures.
 *
 * Recognizes IfElseComposite and IfElseBuilder patterns and adds the if node
 * and its branches to the workflow graph.
 */
export const ifElseHandler: CompositeHandlerPlugin<IfElseInput> = {
	id: 'core:if-else',
	name: 'If/Else Handler',
	priority: 100,

	canHandle(input: unknown): input is IfElseInput {
		return isIfElseComposite(input) || isIfElseBuilder(input);
	},

	getHeadNodeName(input: IfElseInput): { name: string; id: string } {
		if (isIfElseBuilder(input)) {
			return { name: input.ifNode.name, id: input.ifNode.id };
		}
		const composite = input as IfElseComposite;
		return { name: composite.ifNode.name, id: composite.ifNode.id };
	},

	collectPinData(
		input: IfElseInput,
		collector: (node: NodeInstance<string, string, unknown>) => void,
	): void {
		// Collect from IF node
		if (isIfElseBuilder(input)) {
			collector(input.ifNode);
			collectFromBranch(input.trueBranch, collector);
			collectFromBranch(input.falseBranch, collector);
		} else {
			const composite = input as IfElseComposite;
			collector(composite.ifNode);
			collectFromBranch(composite.trueBranch, collector);
			collectFromBranch(composite.falseBranch, collector);
		}
	},

	addNodes(input: IfElseInput, ctx: MutablePluginContext): string {
		const ifMainConns = new Map<number, ConnectionTarget[]>();

		// Handle IfElseBuilder differently - need to set up connections BEFORE adding branches
		if (isIfElseBuilder(input)) {
			const builder = input as IfElseBuilder<unknown>;

			// IMPORTANT: Build IF connections BEFORE adding branch nodes
			// This ensures that when merge handlers run, they can detect existing IF→Merge connections
			// and skip creating duplicates at the wrong output index

			// Connect IF to true branch (output 0)
			processBranchForBuilder(builder.trueBranch, 0, builder.ifNode, ifMainConns);

			// Connect IF to false branch (output 1)
			processBranchForBuilder(builder.falseBranch, 1, builder.ifNode, ifMainConns);

			// Add the IF node with connections to branches
			// If the node already exists (e.g., added by merge handler via addBranchToGraph),
			// merge the connections rather than overwriting
			const existingIfNode = ctx.nodes.get(builder.ifNode.name);
			if (existingIfNode) {
				// Merge ifMainConns into existing connections
				const existingMainConns = existingIfNode.connections.get('main') || new Map();
				for (const [outputIndex, targets] of ifMainConns) {
					const existingTargets = existingMainConns.get(outputIndex) || [];
					// Add new targets that don't already exist
					for (const target of targets) {
						const alreadyExists = existingTargets.some(
							(t: ConnectionTarget) => t.node === target.node && t.index === target.index,
						);
						if (!alreadyExists) {
							existingTargets.push(target);
						}
					}
					existingMainConns.set(outputIndex, existingTargets);
				}
				existingIfNode.connections.set('main', existingMainConns);
			} else {
				// Node doesn't exist, add it fresh
				const ifConns = new Map<string, Map<number, ConnectionTarget[]>>();
				ifConns.set('main', ifMainConns);
				ctx.nodes.set(builder.ifNode.name, {
					instance: builder.ifNode,
					connections: ifConns,
				});
			}

			// NOW add branch nodes - this must happen AFTER IF node is added with its connections
			// so that merge handlers can detect existing IF→Merge connections and skip duplicates
			addBranchTargetNodes(builder.trueBranch, ctx);
			addBranchTargetNodes(builder.falseBranch, ctx);

			return builder.ifNode.name;
		}

		// IfElseComposite: add branches first, then use results for connections
		const composite = input as IfElseComposite;

		// Process true branch (output 0)
		processBranchForComposite(composite.trueBranch, 0, ctx, ifMainConns);

		// Process false branch (output 1)
		processBranchForComposite(composite.falseBranch, 1, ctx, ifMainConns);

		// Add the IF node with connections to branches
		const ifConns = new Map<string, Map<number, ConnectionTarget[]>>();
		ifConns.set('main', ifMainConns);
		ctx.nodes.set(composite.ifNode.name, {
			instance: composite.ifNode,
			connections: ifConns,
		});

		return composite.ifNode.name;
	},
};
