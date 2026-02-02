import { tool } from '@langchain/core/tools';
import type { Logger } from '@n8n/backend-common';
import type { IConnections } from 'n8n-workflow';
import { z } from 'zod';

import type { BuilderTool, BuilderToolBase } from '@/utils/stream-processor';

import { ValidationError, ToolExecutionError } from '../errors';
import { createProgressReporter, reportProgress } from './helpers/progress';
import { createSuccessResponse, createErrorResponse } from './helpers/response';
import { getCurrentWorkflow, getWorkflowState, removeNodeFromWorkflow } from './helpers/state';
import { findNodeByName, createNodeNotFoundError } from './helpers/validation';
import type { RemoveNodeOutput } from '../types/tools';

/**
 * Schema for the remove node tool
 */
const removeNodeSchema = z.object({
	nodeName: z.string().describe('The name of the node to remove from the workflow'),
});

/**
 * Count connections that will be removed for a node
 */
function countNodeConnections(nodeName: string, connections: IConnections): number {
	let count = 0;

	// Count outgoing connections (connections are keyed by node name)
	if (connections[nodeName]) {
		for (const connectionType of Object.values(connections[nodeName])) {
			if (Array.isArray(connectionType)) {
				for (const outputs of connectionType) {
					if (Array.isArray(outputs)) {
						count += outputs.length;
					}
				}
			}
		}
	}

	// Count incoming connections
	for (const [_sourceNodeName, nodeConnections] of Object.entries(connections)) {
		for (const outputs of Object.values(nodeConnections)) {
			if (Array.isArray(outputs)) {
				for (const outputConnections of outputs) {
					if (Array.isArray(outputConnections)) {
						count += outputConnections.filter((conn) => conn.node === nodeName).length;
					}
				}
			}
		}
	}

	return count;
}

/**
 * Build the response message for the removed node
 */
function buildResponseMessage(
	nodeName: string,
	nodeType: string,
	connectionsRemoved: number,
): string {
	const parts: string[] = [`Successfully removed node "${nodeName}" (${nodeType})`];

	if (connectionsRemoved > 0) {
		parts.push(`Removed ${connectionsRemoved} connection${connectionsRemoved > 1 ? 's' : ''}`);
	}

	return parts.join('\n');
}

export const REMOVE_NODE_TOOL: BuilderToolBase = {
	toolName: 'remove_node',
	displayTitle: 'Removing node',
};

/**
 * Factory function to create the remove node tool
 */
export function createRemoveNodeTool(_logger?: Logger): BuilderTool {
	const dynamicTool = tool(
		(input, config) => {
			const reporter = createProgressReporter(
				config,
				REMOVE_NODE_TOOL.toolName,
				REMOVE_NODE_TOOL.displayTitle,
			);

			try {
				// Validate input using Zod schema
				const validatedInput = removeNodeSchema.parse(input);
				const { nodeName } = validatedInput;

				// Report tool start
				reporter.start(validatedInput);

				// Get current state
				const state = getWorkflowState();
				const workflow = getCurrentWorkflow(state);

				// Report progress
				reportProgress(reporter, `Removing node "${nodeName}"`);

				// Find the node to remove by name
				const nodeToRemove = findNodeByName(nodeName, workflow.nodes);

				if (!nodeToRemove) {
					const error = createNodeNotFoundError(nodeName);
					reporter.error(error);
					return createErrorResponse(config, error);
				}

				// Count connections that will be removed (using node name)
				const connectionsRemoved = countNodeConnections(nodeToRemove.name, workflow.connections);

				// Build success message
				const message = buildResponseMessage(
					nodeToRemove.name,
					nodeToRemove.type,
					connectionsRemoved,
				);

				// Report completion
				const output: RemoveNodeOutput = {
					removedNodeName: nodeToRemove.name,
					removedNodeType: nodeToRemove.type,
					connectionsRemoved,
					message,
				};
				reporter.complete(output);

				// Return success with state updates (pass node name)
				const stateUpdates = removeNodeFromWorkflow(nodeToRemove.name);
				return createSuccessResponse(config, message, stateUpdates);
			} catch (error) {
				// Handle validation or unexpected errors
				if (error instanceof z.ZodError) {
					const validationError = new ValidationError('Invalid input parameters', {
						extra: { errors: error.errors },
					});
					reporter.error(validationError);
					return createErrorResponse(config, validationError);
				}

				const toolError = new ToolExecutionError(
					error instanceof Error ? error.message : 'Unknown error occurred',
					{
						toolName: REMOVE_NODE_TOOL.toolName,
						cause: error instanceof Error ? error : undefined,
					},
				);
				reporter.error(toolError);
				return createErrorResponse(config, toolError);
			}
		},
		{
			name: REMOVE_NODE_TOOL.toolName,
			description:
				'Remove a node from the workflow by its name. This will also remove all connections to and from the node. Use this tool when you need to delete a node that is no longer needed in the workflow.',
			schema: removeNodeSchema,
		},
	);

	return {
		tool: dynamicTool,
		...REMOVE_NODE_TOOL,
	};
}
