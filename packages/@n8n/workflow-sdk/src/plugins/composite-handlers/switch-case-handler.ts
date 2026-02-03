/**
 * Switch/Case Composite Handler Plugin
 *
 * Handles SwitchCaseComposite structures - switch/case branching patterns.
 */

import type { CompositeHandlerPlugin, MutablePluginContext } from '../types';
import type { SwitchCaseComposite, ConnectionTarget, NodeInstance } from '../../types/base';
import { isSwitchCaseComposite } from '../../workflow-builder/type-guards';

/**
 * Handler for Switch/Case composite structures.
 *
 * Recognizes SwitchCaseComposite patterns and adds the switch node and its cases
 * to the workflow graph.
 */
export const switchCaseHandler: CompositeHandlerPlugin<SwitchCaseComposite> = {
	id: 'core:switch-case',
	name: 'Switch/Case Handler',
	priority: 100,

	canHandle(input: unknown): input is SwitchCaseComposite {
		return isSwitchCaseComposite(input);
	},

	addNodes(input: SwitchCaseComposite, ctx: MutablePluginContext): string {
		// Build the switch node connections to its cases
		const switchMainConns = new Map<number, ConnectionTarget[]>();

		// Add all case nodes and build connections from switch to each case
		// Skip null cases (unconnected outputs)
		// Handle arrays for fan-out (one output to multiple parallel nodes)
		input.cases.forEach((caseNode, index) => {
			if (caseNode === null) {
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
		});

		// Add the switch node with connections to cases
		const switchConns = new Map<string, Map<number, ConnectionTarget[]>>();
		switchConns.set('main', switchMainConns);
		ctx.nodes.set(input.switchNode.name, {
			instance: input.switchNode,
			connections: switchConns,
		});

		// Return the switch node name as the head of this composite
		return input.switchNode.name;
	},
};
