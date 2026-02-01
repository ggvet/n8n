import type {
	IDisplayOptions,
	INodeParameters,
	INodeProperties,
	INodeTypeDescription,
} from 'n8n-workflow';

/**
 * Represents a subnode requirement for AI nodes
 * Extracted from builderHint.inputs on node type descriptions
 */
export interface SubnodeRequirement {
	/** The connection type (e.g., 'ai_languageModel', 'ai_memory') */
	connectionType: string;
	/** Whether this subnode is required */
	required: boolean;
	/** Conditions under which this subnode is required (e.g., when hasOutputParser is true) */
	displayOptions?: IDisplayOptions;
}

/**
 * Detailed information about a node type
 */
export interface NodeDetails {
	name: string;
	displayName: string;
	description: string;
	properties: INodeProperties[];
	subtitle?: string;
	inputs: INodeTypeDescription['inputs'];
	outputs: INodeTypeDescription['outputs'];
}

/**
 * Node search result with scoring
 */
export interface NodeSearchResult {
	name: string;
	displayName: string;
	description: string;
	version: number;
	score: number;
	inputs: INodeTypeDescription['inputs'];
	outputs: INodeTypeDescription['outputs'];
	/** General hint message for workflow builders (from builderHint.message) */
	builderHintMessage?: string;
	/** Subnode requirements extracted from builderHint.inputs */
	subnodeRequirements?: SubnodeRequirement[];
}

/**
 * Information about a node that was added to the workflow
 */
export interface AddedNode {
	id: string;
	name: string;
	type: string;
	displayName?: string;
	parameters?: INodeParameters;
	position: [number, number];
}
