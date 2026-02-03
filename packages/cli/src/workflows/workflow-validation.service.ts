import { WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import {
	validateWorkflowHasTriggerLikeNode,
	NodeHelpers,
	ensureError,
	isNodeConnectionType,
} from 'n8n-workflow';
import type { INode, INodes, IConnections, INodeType, NodeConnectionType } from 'n8n-workflow';

import { STARTING_NODES } from '@/constants';
import type { NodeTypes } from '@/node-types';

export interface WorkflowValidationResult {
	isValid: boolean;
	error?: string;
}

export interface SubWorkflowValidationResult extends WorkflowValidationResult {
	invalidReferences?: Array<{
		nodeName: string;
		workflowId: string;
		workflowName?: string;
	}>;
}

export interface WorkflowStatus {
	exists: boolean;
	isPublished: boolean;
	name?: string;
}

@Service()
export class WorkflowValidationService {
	constructor(private readonly workflowRepository: WorkflowRepository) {}

	/**
	 * Validates node configuration (credentials, parameters) for connected and enabled nodes.
	 * Trigger-like nodes are always validated even without connections.
	 */
	private validateNodeConfiguration(
		nodes: INode[],
		connections: IConnections,
		nodeTypes: NodeTypes,
	): WorkflowValidationResult {
		try {
			const connectionsByDestination = this.mapConnectionsByDestination(connections);
			const issuesFound: Array<{ nodeName: string; issues: string[] }> = [];

			for (const node of nodes) {
				try {
					if (node.disabled) continue;

					const nodeType = nodeTypes.getByNameAndVersion(node.type, node.typeVersion);

					if (!nodeType) {
						issuesFound.push({
							nodeName: node.name,
							issues: ['Node type not found'],
						});
						continue;
					}

					const isTriggerLikeNode =
						nodeType.trigger !== undefined ||
						nodeType.webhook !== undefined ||
						nodeType.poll !== undefined;

					const isConnected = this.isNodeConnected(
						node.name,
						connections,
						connectionsByDestination,
					);

					if (!isConnected && !isTriggerLikeNode) continue;

					const nodeIssues: string[] = [];
					const credentialIssues = this.validateNodeCredentials(node, nodeType);
					nodeIssues.push(...credentialIssues);

					const parameterIssues = this.validateNodeParameters(node, nodeType);
					nodeIssues.push(...parameterIssues);

					if (nodeIssues.length > 0) {
						issuesFound.push({
							nodeName: node.name,
							issues: nodeIssues,
						});
					}
				} catch (nodeError) {
					issuesFound.push({
						nodeName: node.name,
						issues: [`Error validating node: ${ensureError(nodeError).message}`],
					});
				}
			}

			if (issuesFound.length === 0) {
				return { isValid: true };
			}

			const errorLines = issuesFound.map((item) => {
				const issuesList = item.issues.map((issue) => `  - ${issue}`).join('\n');
				return `Node "${item.nodeName}":\n${issuesList}`;
			});

			const nodeCount = issuesFound.length;
			const pluralSuffix = nodeCount === 1 ? '' : 's';
			const error = `Cannot publish workflow: ${nodeCount} node${pluralSuffix} have configuration issues:\n\n${errorLines.join('\n\n')}`;

			return {
				isValid: false,
				error,
			};
		} catch (error) {
			return {
				isValid: false,
				error: `Workflow validation failed: ${ensureError(error).message}`,
			};
		}
	}

	/**
	 * Checks if a node has any incoming or outgoing connections.
	 */
	private isNodeConnected(
		nodeName: string,
		connections: IConnections,
		connectionsByDestination: IConnections,
	): boolean {
		if (connections[nodeName] && Object.keys(connections[nodeName]).length > 0) {
			return true;
		}

		if (
			connectionsByDestination[nodeName] &&
			Object.keys(connectionsByDestination[nodeName]).length > 0
		) {
			return true;
		}

		return false;
	}

	/**
	 * Inverts the connections object to map by destination node.
	 * Used to find incoming connections for a node.
	 */
	private mapConnectionsByDestination(connections: IConnections): IConnections {
		const destinationMap: IConnections = {};

		for (const [sourceNode, nodeConnections] of Object.entries(connections)) {
			for (const [connectionType, connectionArrays] of Object.entries(nodeConnections)) {
				if (!Array.isArray(connectionArrays)) continue;

				if (!isNodeConnectionType(connectionType)) continue;
				const typedConnectionType: NodeConnectionType = connectionType;

				connectionArrays.forEach((connectionArray, outputIndex) => {
					if (!Array.isArray(connectionArray)) return;

					connectionArray.forEach((connection) => {
						const destNode = connection.node;

						if (!destinationMap[destNode]) {
							destinationMap[destNode] = {};
						}

						if (!destinationMap[destNode][typedConnectionType]) {
							destinationMap[destNode][typedConnectionType] = [];
						}

						const inputIndex = connection.index ?? 0;
						if (!destinationMap[destNode][typedConnectionType][inputIndex]) {
							destinationMap[destNode][typedConnectionType][inputIndex] = [];
						}

						destinationMap[destNode][typedConnectionType][inputIndex].push({
							node: sourceNode,
							type: typedConnectionType,
							index: outputIndex,
						});
					});
				});
			}
		}

		return destinationMap;
	}

	/**
	 * Validates that all required credentials are set for a node.
	 * Respects displayOptions to only validate credentials that should be shown.
	 */
	private validateNodeCredentials(node: INode, nodeType: INodeType): string[] {
		const issues: string[] = [];
		const credentialDescriptions = nodeType.description?.credentials || [];

		for (const credDesc of credentialDescriptions) {
			if (!credDesc.required) continue;

			// Check if this credential should be displayed based on displayOptions
			const shouldDisplay = NodeHelpers.displayParameter(
				node.parameters,
				credDesc,
				node,
				nodeType.description,
			);

			if (!shouldDisplay) continue;

			const credentialName = credDesc.name;
			const nodeCredential = node.credentials?.[credentialName];

			if (!nodeCredential) {
				const displayName = credDesc.displayName || credentialName;
				issues.push(`Missing required credential: ${displayName}`);
				continue;
			}

			if (!nodeCredential.id) {
				const displayName = credDesc.displayName || credentialName;
				issues.push(`Credential not configured: ${displayName}`);
			}
		}

		return issues;
	}

	/**
	 * Validates node parameters using NodeHelpers.
	 */
	private validateNodeParameters(node: INode, nodeType: INodeType): string[] {
		const issues: string[] = [];

		try {
			if (!nodeType.description?.properties) {
				return issues;
			}

			const nodeIssues = NodeHelpers.getNodeParametersIssues(
				nodeType.description.properties,
				node,
				nodeType.description,
			);

			if (nodeIssues?.parameters) {
				const parameterIssuesCount = Object.keys(nodeIssues.parameters).length;
				if (parameterIssuesCount > 0) {
					issues.push(
						`Missing or invalid required parameters (${parameterIssuesCount} issue${parameterIssuesCount === 1 ? '' : 's'})`,
					);
				}
			}
		} catch (error) {
			issues.push('Error validating node parameters');
		}

		return issues;
	}

	validateForActivation(
		nodes: INodes,
		connections: IConnections,
		nodeTypes: NodeTypes,
	): WorkflowValidationResult {
		// Validate trigger nodes
		const triggerValidation = validateWorkflowHasTriggerLikeNode(nodes, nodeTypes, STARTING_NODES);

		if (!triggerValidation.isValid) {
			return {
				isValid: false,
				error:
					triggerValidation.error ??
					'Workflow cannot be activated because it has no trigger node. At least one trigger, webhook, or polling node is required.',
			};
		}

		// Validate node configuration (credentials, parameters)
		const nodesArray = Object.values(nodes);
		const configValidation = this.validateNodeConfiguration(nodesArray, connections, nodeTypes);

		if (!configValidation.isValid) {
			return configValidation;
		}

		return { isValid: true };
	}

	/**
	 * Validates that all sub-workflow references in a workflow are published.
	 *
	 * This prevents publishing a parent workflow that references draft-only sub-workflows,
	 * which would cause runtime errors when the workflow is triggered in production.
	 *
	 */
	async validateSubWorkflowReferences(
		workflowId: string,
		nodes: INode[],
	): Promise<SubWorkflowValidationResult> {
		const executeWorkflowNodes = nodes.filter(
			(node) => node.type === 'n8n-nodes-base.executeWorkflow' && !node.disabled,
		);

		if (executeWorkflowNodes.length === 0) {
			return { isValid: true };
		}

		const invalidReferences: Array<{
			nodeName: string;
			workflowId: string;
			workflowName?: string;
		}> = [];

		for (const node of executeWorkflowNodes) {
			const subWorkflowId = this.extractWorkflowId(node);
			const source: string | undefined =
				typeof node.parameters?.source === 'string' ? node.parameters.source : undefined;

			if (this.shouldSkipSubWorkflowValidation(subWorkflowId, source)) {
				continue;
			}

			const status = await this.getWorkflowStatus(workflowId, subWorkflowId!);

			if (!status.exists || !status.isPublished) {
				invalidReferences.push({
					nodeName: node.name,
					workflowId: subWorkflowId!,
					workflowName: status.exists ? status.name : undefined,
				});
			}
		}

		if (invalidReferences.length > 0) {
			const errorMessages = invalidReferences.map((ref) => {
				const workflowName = ref.workflowName ? ` ("${ref.workflowName}")` : '';
				return `Node "${ref.nodeName}" references workflow ${ref.workflowId}${workflowName} which is not published`;
			});

			return {
				isValid: false,
				error: `Cannot publish workflow: ${errorMessages.join('; ')}. Please publish all referenced sub-workflows first.`,
				invalidReferences,
			};
		}

		return { isValid: true };
	}

	/**
	 * Gets the status of a sub-workflow for validation purposes.
	 * Allows self-referencing workflows (workflow calling itself).
	 */
	private async getWorkflowStatus(
		parentWorkflowId: string,
		subWorkflowId: string,
	): Promise<WorkflowStatus> {
		// Allow self-reference (workflow calling itself)
		if (subWorkflowId === parentWorkflowId) {
			return { exists: true, isPublished: true };
		}

		const subWorkflow = await this.workflowRepository.get({ id: subWorkflowId }, { relations: [] });

		if (!subWorkflow) {
			return { exists: false, isPublished: false };
		}

		return {
			exists: true,
			isPublished: subWorkflow.activeVersionId !== null,
			name: subWorkflow.name,
		};
	}

	/**
	 * Type guard to check if a value is an object with a value property.
	 */
	private hasValueProperty(obj: unknown): obj is { value?: string } {
		return typeof obj === 'object' && obj !== null && 'value' in obj;
	}

	/**
	 * Extracts the workflow ID from an Execute Workflow node's parameters.
	 * Handles both old format (string) and new format (object with value property).
	 */
	private extractWorkflowId(node: INode): string | undefined {
		const workflowIdParam = node.parameters?.workflowId;

		if (this.hasValueProperty(workflowIdParam)) {
			return workflowIdParam.value;
		}

		if (typeof workflowIdParam === 'string') {
			return workflowIdParam;
		}

		return undefined;
	}

	/**
	 * Determines if a sub-workflow reference should be skipped during validation.
	 * Skips when:
	 * - No workflow ID is provided
	 * - Workflow ID is an expression (starts with '=')
	 * - Source is not 'database' (e.g., url, parameter, localFile)
	 */
	private shouldSkipSubWorkflowValidation(
		workflowId: string | undefined,
		source: string | undefined,
	): boolean {
		if (!workflowId) return true;
		if (workflowId.startsWith('=')) return true;
		if (source && source !== 'database') return true;
		return false;
	}
}
