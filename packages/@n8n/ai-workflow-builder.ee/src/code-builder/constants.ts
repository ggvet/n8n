/**
 * Constants for the Code Builder Agent
 *
 * Extracted from code-builder-agent.ts for better organization and testability.
 */

import type { BuilderToolBase } from '@/utils/stream-processor';

/** Maximum iterations for the agentic loop to prevent infinite loops */
export const MAX_AGENT_ITERATIONS = 50;

/** Maximum validate attempts before giving up in text editor mode */
export const MAX_VALIDATE_ATTEMPTS = 10;

/** Mandatory instruction appended to validation/parse error messages */
export const FIX_AND_FINALIZE_INSTRUCTION = `

IMPORTANT: After fixing the issues above, you MUST do ONE of:
1. Call validate_workflow to verify your fixes are correct, OR
2. Stop calling tools to trigger auto-finalize

Do NOT continue making edits indefinitely without validating.`;

/** Native Anthropic text editor tool configuration */
export const TEXT_EDITOR_TOOL = {
	type: 'text_editor_20250728' as const,
	name: 'str_replace_based_edit_tool' as const,
};

/** Validate workflow tool schema - separate from text editor for clearer separation of concerns */
export const VALIDATE_TOOL = {
	type: 'function' as const,
	function: {
		name: 'validate_workflow',
		description:
			'Validate the current workflow code for errors. Returns validation results - either success or a list of errors to fix.',
		parameters: {
			type: 'object' as const,
			properties: {
				path: {
					type: 'string' as const,
					description: 'Path to the workflow file (must be /workflow.ts)',
				},
			},
			required: ['path'],
		},
	},
};

/**
 * CodeBuilderAgent tools for display when session is loaded
 */
export const CODE_BUILDER_TEXT_EDITOR_TOOL: BuilderToolBase = {
	toolName: 'str_replace_based_edit_tool',
	displayTitle: 'Crafting workflow',
};

export const CODE_BUILDER_VALIDATE_TOOL: BuilderToolBase = {
	toolName: 'validate_workflow',
	displayTitle: 'Validating workflow',
};

export const CODE_BUILDER_GET_NODE_TYPES_TOOL: BuilderToolBase = {
	toolName: 'get_node_types',
	displayTitle: 'Looking up nodes',
};

export const CODE_BUILDER_GET_SUGGESTED_NODES_TOOL: BuilderToolBase = {
	toolName: 'get_suggested_nodes',
	displayTitle: 'Getting suggestions',
};
