import { computed, type Ref } from 'vue';
import sortBy from 'lodash/sortBy';

import type { INodeUi } from '@/Interface';
import type { NodeCredentialRequirement, NodeSetupState } from '../setupPanel.types';

import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { useCredentialsStore } from '@/features/credentials/credentials.store';
import { useNodeHelpers } from '@/app/composables/useNodeHelpers';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import { injectWorkflowState } from '@/app/composables/useWorkflowState';
import { getNodeTypeDisplayableCredentials } from '@/app/utils/nodes/nodeTransforms';

/**
 * Composable that manages workflow setup state for credential configuration.
 * Derives state from node type definitions and current node credentials,
 * marking nodes as complete/incomplete based on credential selection and issues.
 * @param nodes Optional sub-set of nodes to check (defaults to full workflow)
 */
export const useWorkflowSetupState = (nodes?: Ref<INodeUi[]>) => {
	const workflowsStore = useWorkflowsStore();
	const credentialsStore = useCredentialsStore();
	const nodeTypesStore = useNodeTypesStore();
	const nodeHelpers = useNodeHelpers();
	const workflowState = injectWorkflowState();

	const sourceNodes = computed(() => nodes?.value ?? workflowsStore.allNodes);

	/**
	 * Get nodes that require credentials, sorted by X position (left to right).
	 */
	const nodesRequiringCredentials = computed(() => {
		const nodesWithCredentials = sourceNodes.value
			.filter((node) => !node.disabled)
			.map((node) => ({
				node,
				requiredCredentials: getNodeTypeDisplayableCredentials(nodeTypesStore, node),
			}))
			.filter(({ requiredCredentials }) => requiredCredentials.length > 0);

		return sortBy(nodesWithCredentials, ({ node }) => node.position[0]);
	});

	const getCredentialDisplayName = (credentialType: string): string => {
		const credentialTypeInfo = credentialsStore.getCredentialTypeByName(credentialType);
		return credentialTypeInfo?.displayName ?? credentialType;
	};

	/**
	 * Node setup states - one entry per node that requires credentials.
	 * This data is used by cards component.
	 */
	const nodeSetupStates = computed<NodeSetupState[]>(() => {
		return nodesRequiringCredentials.value.map(({ node, requiredCredentials }) => {
			const credentialIssues = node.issues?.credentials ?? {};

			// Build requirements from node type's required credentials
			const credentialRequirements: NodeCredentialRequirement[] = requiredCredentials.map(
				(credentialDescription) => {
					const credType = credentialDescription.name;
					const credValue = node.credentials?.[credType];
					const selectedCredentialId =
						typeof credValue === 'string' ? undefined : (credValue?.id ?? undefined);

					// Get current issues for this credential type (if any)
					const issues = credentialIssues[credType];
					const issueMessages = issues ? (Array.isArray(issues) ? issues : [issues]) : [];

					return {
						credentialType: credType,
						credentialDisplayName: getCredentialDisplayName(credType),
						selectedCredentialId,
						issues: issueMessages,
					};
				},
			);

			const isComplete = credentialRequirements.every(
				(req) => req.selectedCredentialId && req.issues.length === 0,
			);

			return {
				node,
				credentialRequirements,
				isComplete,
			};
		});
	});

	const totalCredentialsMissing = computed(() => {
		return nodeSetupStates.value.reduce((total, state) => {
			const missing = state.credentialRequirements.filter(
				(req) => !req.selectedCredentialId || req.issues.length > 0,
			);
			return total + missing.length;
		}, 0);
	});

	const totalNodesRequiringSetup = computed(() => {
		return nodeSetupStates.value.length;
	});

	const isAllComplete = computed(() => {
		return (
			nodeSetupStates.value.length > 0 && nodeSetupStates.value.every((state) => state.isComplete)
		);
	});

	const setCredential = (nodeName: string, credentialType: string, credentialId: string): void => {
		const credential = credentialsStore.getCredentialById(credentialId);
		if (!credential) return;

		const node = workflowsStore.getNodeByName(nodeName);
		if (!node) return;

		workflowState.updateNodeProperties({
			name: nodeName,
			properties: {
				credentials: {
					...node.credentials,
					[credentialType]: { id: credentialId, name: credential.name },
				},
			},
		});
		nodeHelpers.updateNodeCredentialIssuesByName(nodeName);
	};

	const unsetCredential = (nodeName: string, credentialType: string): void => {
		const node = workflowsStore.getNodeByName(nodeName);
		if (!node) return;

		const updatedCredentials = { ...node.credentials };
		delete updatedCredentials[credentialType];

		workflowState.updateNodeProperties({
			name: nodeName,
			properties: {
				credentials: updatedCredentials,
			},
		});
		nodeHelpers.updateNodeCredentialIssuesByName(nodeName);
	};

	return {
		nodeSetupStates,
		totalCredentialsMissing,
		totalNodesRequiringSetup,
		isAllComplete,
		setCredential,
		unsetCredential,
	};
};
