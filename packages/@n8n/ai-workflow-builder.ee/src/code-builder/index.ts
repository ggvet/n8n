/**
 * Code Builder Module
 *
 * Public API for the code builder agent and related utilities.
 */

// Agent
export { CodeBuilderAgent } from './code-builder-agent';

// Constants
export {
	MAX_AGENT_ITERATIONS,
	MAX_VALIDATE_ATTEMPTS,
	FIX_AND_FINALIZE_INSTRUCTION,
	TEXT_EDITOR_TOOL,
	VALIDATE_TOOL,
	SONNET_4_5_PRICING,
} from './constants';

// Types
export type {
	WorkflowCodeOutput,
	ParseAndValidateResult,
	ValidationWarning,
	CodeBuilderAgentConfig,
} from './types';

// Utilities
export { calculateCost } from './utils/cost-calculator';
export { extractTextContent, extractThinkingContent } from './utils/content-extractors';
export { processLlmResponse } from './utils/llm-response-processor';
export type { LlmResponseResult, ToolCall } from './utils/llm-response-processor';

// State management
export { ChatState } from './state/chat-state';
export { WarningTracker } from './state/warning-tracker';

// Handlers
export { ParseValidateHandler } from './handlers/parse-validate-handler';
export type {
	ParseValidateHandlerConfig,
	ValidationFeedbackResult,
	ParseErrorResult,
} from './handlers/parse-validate-handler';

export { ValidateToolHandler } from './handlers/validate-tool-handler';
export type {
	ValidateToolHandlerConfig,
	ValidateToolParams,
	ValidateToolResult,
} from './handlers/validate-tool-handler';

export { TextEditorToolHandler } from './handlers/text-editor-tool-handler';
export type {
	TextEditorToolHandlerConfig,
	TextEditorToolParams,
	TextEditorToolResult,
} from './handlers/text-editor-tool-handler';

export { AutoFinalizeHandler } from './handlers/auto-finalize-handler';
export type {
	AutoFinalizeHandlerConfig,
	AutoFinalizeParams,
	AutoFinalizeResult,
} from './handlers/auto-finalize-handler';

// Code Workflow Builder
export {
	CodeWorkflowBuilder,
	createCodeWorkflowBuilder,
} from './code-workflow-builder';
export type { CodeWorkflowBuilderConfig } from './code-workflow-builder';

// Session utilities
export {
	loadCodeBuilderSession,
	saveCodeBuilderSession,
	compactSessionIfNeeded,
	generateCodeBuilderThreadId,
	saveSessionMessages,
} from './utils/code-builder-session';
export type { CodeBuilderSession } from './utils/code-builder-session';
