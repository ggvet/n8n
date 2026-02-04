/**
 * Chat Setup Handler
 *
 * Handles the setup phase of the chat() method in CodeBuilderAgent.
 * Extracts initialization logic to reduce cyclomatic complexity in chat().
 */

import type {
	BaseChatModel,
	BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { Runnable } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { generateWorkflowCode } from '@n8n/workflow-sdk';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { ChatPayload } from '../../workflow-builder-agent';
import { TEXT_EDITOR_TOOL, VALIDATE_TOOL } from '../constants';
import { buildCodeBuilderPrompt, type HistoryContext } from '../prompts';
import { TextEditorHandler } from './text-editor-handler';
import { TextEditorToolHandler } from './text-editor-tool-handler';
import type { TextEditorCommand } from './text-editor.types';
import type { ParseAndValidateResult } from '../types';
import { SDK_IMPORT_STATEMENT } from '../utils/extract-code';

/**
 * Debug log callback type
 */
type DebugLogFn = (context: string, message: string, data?: Record<string, unknown>) => void;

/**
 * Parse and validate function type
 */
type ParseAndValidateFn = (
	code: string,
	currentWorkflow?: WorkflowJSON,
) => Promise<ParseAndValidateResult>;

/**
 * Get error context function type
 */
type GetErrorContextFn = (code: string, errorMessage: string) => string;

/**
 * Configuration for ChatSetupHandler
 */
export interface ChatSetupHandlerConfig {
	llm: BaseChatModel;
	tools: StructuredToolInterface[];
	enableTextEditorConfig?: boolean;
	debugLog: DebugLogFn;
	parseAndValidate: ParseAndValidateFn;
	getErrorContext: GetErrorContextFn;
}

/**
 * Parameters for setup execution
 */
export interface ChatSetupParams {
	payload: ChatPayload;
	historyContext?: HistoryContext;
}

/**
 * Type for LLM with tools bound - matches what AgentIterationHandler expects
 */
export type LlmWithTools = Runnable<BaseMessage[], AIMessage, BaseChatModelCallOptions>;

/**
 * Result of chat setup
 */
export interface ChatSetupResult {
	llmWithTools: LlmWithTools;
	messages: BaseMessage[];
	textEditorEnabled: boolean;
	preGeneratedWorkflowCode?: string;
	currentWorkflow?: WorkflowJSON;
	textEditorHandler?: TextEditorHandler;
	textEditorToolHandler?: TextEditorToolHandler;
}

/**
 * Handles the setup phase of the chat() method.
 *
 * This handler:
 * 1. Determines if text editor should be enabled
 * 2. Pre-generates workflow code for consistency
 * 3. Builds the prompt with workflow context
 * 4. Binds tools to the LLM
 * 5. Formats initial messages
 * 6. Initializes text editor handlers if enabled
 */
export class ChatSetupHandler {
	private llm: BaseChatModel;
	private tools: StructuredToolInterface[];
	private enableTextEditorConfig?: boolean;
	private debugLog: DebugLogFn;
	private parseAndValidate: ParseAndValidateFn;
	private getErrorContext: GetErrorContextFn;

	constructor(config: ChatSetupHandlerConfig) {
		this.llm = config.llm;
		this.tools = config.tools;
		this.enableTextEditorConfig = config.enableTextEditorConfig;
		this.debugLog = config.debugLog;
		this.parseAndValidate = config.parseAndValidate;
		this.getErrorContext = config.getErrorContext;
	}

	/**
	 * Execute the setup phase of chat().
	 *
	 * @param params - Setup parameters
	 * @returns ChatSetupResult with all initialized components
	 */
	async execute(params: ChatSetupParams): Promise<ChatSetupResult> {
		const { payload, historyContext } = params;
		const currentWorkflow = payload.workflowContext?.currentWorkflow as WorkflowJSON | undefined;

		this.logWorkflowContext(currentWorkflow);

		// Pre-generate workflow code for consistency between prompt and text editor
		const preGeneratedWorkflowCode = this.preGenerateWorkflowCode(payload, currentWorkflow);

		// Check if text editor mode should be enabled
		const textEditorEnabled = this.shouldEnableTextEditor();
		this.debugLog('CHAT_SETUP', 'Text editor mode', { textEditorEnabled });

		// Build prompt
		const prompt = buildCodeBuilderPrompt(currentWorkflow, historyContext, {
			enableTextEditor: textEditorEnabled,
			executionSchema: payload.workflowContext?.executionSchema,
			executionData: payload.workflowContext?.executionData,
			expressionValues: payload.workflowContext?.expressionValues,
			preGeneratedCode: preGeneratedWorkflowCode,
		});
		this.logPromptBuilt(historyContext, textEditorEnabled);

		// Bind tools to LLM
		const llmWithTools = this.bindToolsToLlm(textEditorEnabled);

		// Format initial messages
		const messages = await this.formatInitialMessages(prompt, payload.message);

		// Initialize text editor handlers if enabled
		const { textEditorHandler, textEditorToolHandler } = this.initializeTextEditorHandlers(
			textEditorEnabled,
			preGeneratedWorkflowCode,
		);

		return {
			llmWithTools,
			messages,
			textEditorEnabled,
			preGeneratedWorkflowCode,
			currentWorkflow,
			textEditorHandler,
			textEditorToolHandler,
		};
	}

	/**
	 * Determine whether to enable the text editor tool.
	 * Auto-enables for Claude 4.x models if not explicitly configured.
	 */
	private shouldEnableTextEditor(): boolean {
		if (this.enableTextEditorConfig !== undefined) {
			return this.enableTextEditorConfig;
		}
		// Auto-enable for Claude 4.x models (check model name from LLM)
		const modelName = (this.llm as { modelId?: string }).modelId ?? '';
		return (
			modelName.includes('claude-4') ||
			modelName.includes('opus-4') ||
			modelName.includes('sonnet-4')
		);
	}

	/**
	 * Log workflow context information
	 */
	private logWorkflowContext(currentWorkflow?: WorkflowJSON): void {
		if (currentWorkflow) {
			this.debugLog('CHAT_SETUP', 'Current workflow context provided', {
				workflowId: currentWorkflow.id,
				workflowName: currentWorkflow.name,
				nodeCount: currentWorkflow.nodes?.length ?? 0,
			});
		}
	}

	/**
	 * Pre-generate workflow code with execution context
	 */
	private preGenerateWorkflowCode(
		payload: ChatPayload,
		currentWorkflow?: WorkflowJSON,
	): string | undefined {
		if (!currentWorkflow) {
			return undefined;
		}

		const code = generateWorkflowCode({
			workflow: currentWorkflow,
			executionSchema: payload.workflowContext?.executionSchema,
			executionData: payload.workflowContext?.executionData,
			expressionValues: payload.workflowContext?.expressionValues,
		});

		this.debugLog('CHAT_SETUP', 'Pre-generated workflow code with execution context', {
			codeLength: code.length,
			hasExecutionSchema: !!payload.workflowContext?.executionSchema,
			hasExecutionData: !!payload.workflowContext?.executionData,
			hasExpressionValues: !!payload.workflowContext?.expressionValues,
		});

		return code;
	}

	/**
	 * Log prompt build information
	 */
	private logPromptBuilt(historyContext?: HistoryContext, textEditorEnabled?: boolean): void {
		this.debugLog('CHAT_SETUP', 'Prompt built successfully', {
			hasHistoryContext: !!historyContext,
			historyMessagesCount: historyContext?.userMessages?.length ?? 0,
			hasPreviousSummary: !!historyContext?.previousSummary,
			textEditorEnabled,
		});
	}

	/**
	 * Bind tools to LLM
	 *
	 * @returns LLM with tools bound, typed for use with AgentIterationHandler
	 */
	private bindToolsToLlm(textEditorEnabled: boolean): LlmWithTools {
		this.debugLog('CHAT_SETUP', 'Binding tools to LLM...');

		if (!this.llm.bindTools) {
			throw new Error('LLM does not support bindTools - cannot use tools for node discovery');
		}

		const toolsToUse = textEditorEnabled
			? [...this.tools, TEXT_EDITOR_TOOL, VALIDATE_TOOL]
			: this.tools;

		// bindTools returns a Runnable that accepts BaseMessage[] and returns AIMessage
		// The type assertion is safe because we're binding tools to a chat model
		const llmWithTools = this.llm.bindTools(toolsToUse) as LlmWithTools;

		this.debugLog('CHAT_SETUP', 'Tools bound to LLM', {
			toolCount: toolsToUse.length,
			includesTextEditor: textEditorEnabled,
		});

		return llmWithTools;
	}

	/**
	 * Format initial messages from the prompt
	 */
	private async formatInitialMessages(
		prompt: ReturnType<typeof buildCodeBuilderPrompt>,
		userMessage: string,
	): Promise<BaseMessage[]> {
		this.debugLog('CHAT_SETUP', 'Formatting initial messages...');

		const formattedMessages = await prompt.formatMessages({ userMessage });
		const messages: BaseMessage[] = [...formattedMessages];

		this.debugLog('CHAT_SETUP', 'Initial messages formatted', {
			messageCount: messages.length,
		});

		for (let i = 0; i < formattedMessages.length; i++) {
			const msg = formattedMessages[i];
			const msgType = msg._getType();
			const content =
				typeof msg.content === 'string'
					? msg.content
					: JSON.stringify(msg.content).substring(0, 2000);
			this.debugLog('CHAT_SETUP', `Message ${i + 1} (${msgType})`, {
				contentLength: typeof msg.content === 'string' ? msg.content.length : 0,
				contentPreview: content,
			});
		}

		return messages;
	}

	/**
	 * Initialize text editor handlers if enabled
	 */
	private initializeTextEditorHandlers(
		textEditorEnabled: boolean,
		preGeneratedWorkflowCode?: string,
	): {
		textEditorHandler?: TextEditorHandler;
		textEditorToolHandler?: TextEditorToolHandler;
	} {
		if (!textEditorEnabled) {
			return {};
		}

		// Create text editor handler with debug logging
		const textEditorHandler = new TextEditorHandler((context, message, data) => {
			this.debugLog(`TEXT_EDITOR_HANDLER:${context}`, message, data);
		});

		// Create text editor tool handler (wraps the text editor handler)
		const textEditorToolHandler = new TextEditorToolHandler({
			textEditorExecute: (args) => textEditorHandler.execute(args as unknown as TextEditorCommand),
			textEditorGetCode: () => textEditorHandler.getWorkflowCode(),
			parseAndValidate: this.parseAndValidate,
			getErrorContext: this.getErrorContext,
			debugLog: this.debugLog,
		});

		// Pre-populate with the SAME code that's in the system prompt
		// This ensures str_replace commands match what the LLM sees
		if (preGeneratedWorkflowCode) {
			const codeWithImport = `${SDK_IMPORT_STATEMENT}\n\n${preGeneratedWorkflowCode}`;
			textEditorHandler.setWorkflowCode(codeWithImport);
			this.debugLog('CHAT_SETUP', 'Pre-populated text editor with workflow code', {
				codeLength: codeWithImport.length,
			});
		}

		return { textEditorHandler, textEditorToolHandler };
	}
}
