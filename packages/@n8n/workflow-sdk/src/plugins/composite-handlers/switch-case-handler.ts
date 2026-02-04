/**
 * Switch/Case Composite Handler Plugin
 *
 * Handles SwitchCaseComposite and SwitchCaseBuilder structures - switch/case branching patterns.
 */

import type { CompositeHandlerPlugin, MutablePluginContext } from '../types';
import type {
	SwitchCaseComposite,
	ConnectionTarget,
	NodeInstance,
	SwitchCaseBuilder,
	IfElseComposite,
	NodeChain,
	IfElseBuilder,
} from '../../types/base';
import { isNodeChain } from '../../types/base';
import {
	isSwitchCaseComposite,
	isIfElseComposite,
	isSplitInBatchesBuilder,
	extractSplitInBatchesBuilder,
} from '../../workflow-builder/type-guards';
import { isSwitchCaseBuilder, isIfElseBuilder } from '../../node-builder';

/**
 * Type representing either Composite or Builder format
 */
type SwitchCaseInput = SwitchCaseComposite | SwitchCaseBuilder<unknown>;

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
 * Helper to collect nodes from a case for pin data gathering.
 * Handles null, single nodes, and arrays.
 */
function collectFromCase(
	caseNode: unknown,
	collector: (node: NodeInstance<string, string, unknown>) => void,
): void {
	if (caseNode === null || caseNode === undefined) return;
	if (Array.isArray(caseNode)) {
		for (const n of caseNode) {
			if (n !== null && n !== undefined) {
				collector(n as NodeInstance<string, string, unknown>);
			}
		}
	} else {
		collector(caseNode as NodeInstance<string, string, unknown>);
	}
}

/**
 * Add nodes from a branch target to the nodes map, recursively handling nested composites.
 * This is used for SwitchCaseBuilder to add case nodes AFTER setting up Switch connections.
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
 * Helper to process a single case node for Composite format (add nodes first)
 */
function processCaseNodeForComposite(
	caseNode: unknown,
	index: number,
	ctx: MutablePluginContext,
	switchMainConns: Map<number, ConnectionTarget[]>,
): void {
	if (caseNode === null || caseNode === undefined) {
		return; // Skip null cases - no connection for this output
	}

	// Check if caseNode is an array (fan-out pattern)
	if (Array.isArray(caseNode)) {
		// Fan-out: multiple parallel targets from this case
		const targets: ConnectionTarget[] = [];
		for (const branchNode of caseNode as (NodeInstance<string, string, unknown> | null)[]) {
			if (branchNode === null) continue;
			const branchHead = ctx.addBranchToGraph(branchNode);
			targets.push({ node: branchHead, type: 'main', index: 0 });
		}
		if (targets.length > 0) {
			switchMainConns.set(index, targets);
		}
	} else {
		const caseHeadName = ctx.addBranchToGraph(caseNode);
		switchMainConns.set(index, [{ node: caseHeadName, type: 'main', index: 0 }]);
	}
}

/**
 * Process a case for SwitchCaseBuilder - compute target names BEFORE adding nodes
 */
function processCaseForBuilder(
	target: unknown,
	caseIndex: number,
	_switchNode: NodeInstance<string, string, unknown>,
	switchMainConns: Map<number, ConnectionTarget[]>,
): void {
	if (target === null || target === undefined) {
		return;
	}

	if (Array.isArray(target)) {
		// Fan-out: multiple targets from one case
		const targets: ConnectionTarget[] = [];
		for (const t of target) {
			const targetName = getTargetNodeName(t);
			if (targetName) {
				targets.push({ node: targetName, type: 'main', index: 0 });
			}
		}
		if (targets.length > 0) {
			switchMainConns.set(caseIndex, targets);
		}
	} else {
		// Single target
		const targetName = getTargetNodeName(target);
		if (targetName) {
			switchMainConns.set(caseIndex, [{ node: targetName, type: 'main', index: 0 }]);
		}
	}
}

/**
 * Handler for Switch/Case composite structures.
 *
 * Recognizes SwitchCaseComposite and SwitchCaseBuilder patterns and adds the
 * switch node and its cases to the workflow graph.
 */
export const switchCaseHandler: CompositeHandlerPlugin<SwitchCaseInput> = {
	id: 'core:switch-case',
	name: 'Switch/Case Handler',
	priority: 100,

	canHandle(input: unknown): input is SwitchCaseInput {
		return isSwitchCaseComposite(input) || isSwitchCaseBuilder(input);
	},

	getHeadNodeName(input: SwitchCaseInput): { name: string; id: string } {
		if (isSwitchCaseBuilder(input)) {
			return { name: input.switchNode.name, id: input.switchNode.id };
		}
		const composite = input as SwitchCaseComposite;
		return { name: composite.switchNode.name, id: composite.switchNode.id };
	},

	collectPinData(
		input: SwitchCaseInput,
		collector: (node: NodeInstance<string, string, unknown>) => void,
	): void {
		// Collect from Switch node
		collector(input.switchNode);

		// Collect from cases
		if ('caseMapping' in input && input.caseMapping instanceof Map) {
			// SwitchCaseBuilder
			for (const [, target] of input.caseMapping) {
				collectFromCase(target, collector);
			}
		} else if ('cases' in input && Array.isArray(input.cases)) {
			// SwitchCaseComposite
			for (const caseNode of input.cases) {
				collectFromCase(caseNode, collector);
			}
		}
	},

	addNodes(input: SwitchCaseInput, ctx: MutablePluginContext): string {
		// Handle sourceChain if present (for trigger.to(switch).onCase() pattern)
		const builderWithChain = input as { sourceChain?: unknown };
		if (builderWithChain.sourceChain) {
			ctx.addBranchToGraph(builderWithChain.sourceChain);
		}

		// Build the switch node connections to its cases
		const switchMainConns = new Map<number, ConnectionTarget[]>();

		// Handle SwitchCaseBuilder differently - need to set up connections BEFORE adding case nodes
		if ('caseMapping' in input && input.caseMapping instanceof Map) {
			const builder = input as SwitchCaseBuilder<unknown>;

			// IMPORTANT: Build Switch connections BEFORE adding case nodes
			// This ensures that when merge handlers run, they can detect existing Switch→Merge connections
			// and skip creating duplicates at the wrong output index

			// Connect switch to each case at the correct output index
			for (const [caseIndex, target] of builder.caseMapping) {
				processCaseForBuilder(target, caseIndex, builder.switchNode, switchMainConns);
			}

			// Add the Switch node with connections to cases
			// If the node already exists (e.g., added by merge handler via addBranchToGraph),
			// merge the connections rather than overwriting
			const existingNode = ctx.nodes.get(builder.switchNode.name);
			if (existingNode) {
				// Merge switchMainConns into existing connections
				const existingMainConns = existingNode.connections.get('main') || new Map();
				for (const [outputIndex, targets] of switchMainConns) {
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
				existingNode.connections.set('main', existingMainConns);
			} else {
				// Node doesn't exist, add it fresh
				const switchConns = new Map<string, Map<number, ConnectionTarget[]>>();
				switchConns.set('main', switchMainConns);
				ctx.nodes.set(builder.switchNode.name, {
					instance: builder.switchNode,
					connections: switchConns,
				});
			}

			// NOW add case nodes - this must happen AFTER Switch node is added with its connections
			// so that merge handlers can detect existing Switch→Merge connections and skip duplicates
			for (const [, target] of builder.caseMapping) {
				addBranchTargetNodes(target, ctx);
			}

			return builder.switchNode.name;
		}

		// SwitchCaseComposite: add cases first, then use results for connections
		if ('cases' in input && Array.isArray(input.cases)) {
			input.cases.forEach((caseNode, index) => {
				processCaseNodeForComposite(caseNode, index, ctx, switchMainConns);
			});
		}

		// Add the switch node with connections to cases
		const switchConns = new Map<string, Map<number, ConnectionTarget[]>>();
		switchConns.set('main', switchMainConns);
		ctx.nodes.set(input.switchNode.name, {
			instance: input.switchNode,
			connections: switchConns,
		});

		return input.switchNode.name;
	},
};
