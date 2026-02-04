/**
 * Chat State Management
 *
 * Centralized state management for the chat loop. Replaces the 10+ scattered
 * state variables that were previously defined in the chat() method.
 */

import type { BaseMessage } from '@langchain/core/messages';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import type { StreamGenerationError } from '../../types/streaming';

/**
 * Manages all state for a single chat session.
 *
 * Consolidates state that was previously scattered across multiple variables
 * in the chat() method, making the code easier to understand and test.
 */
export class ChatState {
	// Core loop state
	private _iteration = 0;
	private _workflow: WorkflowJSON | null = null;
	private _sourceCode: string | null = null;
	private _parseDuration = 0;
	private _consecutiveParseErrors = 0;

	// Token tracking
	private _totalInputTokens = 0;
	private _totalOutputTokens = 0;

	// Message history
	private _messages: BaseMessage[] = [];

	// Text editor mode state
	private _textEditorValidateAttempts = 0;
	private _validatePassedThisIteration = false;

	// Generation error tracking
	private _generationErrors: StreamGenerationError[] = [];

	// ============= Getters =============

	get iteration(): number {
		return this._iteration;
	}

	get workflow(): WorkflowJSON | null {
		return this._workflow;
	}

	get sourceCode(): string | null {
		return this._sourceCode;
	}

	get parseDuration(): number {
		return this._parseDuration;
	}

	get consecutiveParseErrors(): number {
		return this._consecutiveParseErrors;
	}

	get totalInputTokens(): number {
		return this._totalInputTokens;
	}

	get totalOutputTokens(): number {
		return this._totalOutputTokens;
	}

	get totalTokens(): number {
		return this._totalInputTokens + this._totalOutputTokens;
	}

	get messages(): BaseMessage[] {
		return this._messages;
	}

	get textEditorValidateAttempts(): number {
		return this._textEditorValidateAttempts;
	}

	get validatePassedThisIteration(): boolean {
		return this._validatePassedThisIteration;
	}

	get generationErrors(): StreamGenerationError[] {
		return this._generationErrors;
	}

	// ============= Iteration Management =============

	incrementIteration(): void {
		this._iteration++;
	}

	// ============= Token Tracking =============

	recordTokenUsage(inputTokens: number, outputTokens: number): void {
		this._totalInputTokens += inputTokens;
		this._totalOutputTokens += outputTokens;
	}

	// ============= Workflow Management =============

	setWorkflow(workflow: WorkflowJSON, sourceCode: string): void {
		this._workflow = workflow;
		this._sourceCode = sourceCode;
	}

	clearWorkflow(): void {
		this._workflow = null;
	}

	setParseDuration(duration: number): void {
		this._parseDuration = duration;
	}

	// ============= Message Management =============

	addMessage(message: BaseMessage): void {
		this._messages.push(message);
	}

	setMessages(messages: BaseMessage[]): void {
		this._messages = [...messages];
	}

	// ============= Parse Error Tracking =============

	incrementConsecutiveParseErrors(): void {
		this._consecutiveParseErrors++;
	}

	resetConsecutiveParseErrors(): void {
		this._consecutiveParseErrors = 0;
	}

	// ============= Text Editor State =============

	incrementTextEditorValidateAttempts(): void {
		this._textEditorValidateAttempts++;
	}

	setValidatePassedThisIteration(passed: boolean): void {
		this._validatePassedThisIteration = passed;
	}

	resetValidatePassedThisIteration(): void {
		this._validatePassedThisIteration = false;
	}

	// ============= Generation Error Tracking =============

	addGenerationError(error: StreamGenerationError): void {
		this._generationErrors.push(error);
	}

	hasGenerationErrors(): boolean {
		return this._generationErrors.length > 0;
	}

	// ============= Loop Control =============

	/**
	 * Determine if the chat loop should continue.
	 *
	 * @param maxIterations - Maximum number of iterations allowed
	 * @returns true if the loop should continue, false if it should stop
	 */
	shouldContinue(maxIterations: number): boolean {
		// Stop if we have a valid workflow
		if (this._workflow) {
			return false;
		}

		// Stop if we've hit the iteration limit
		if (this._iteration >= maxIterations) {
			return false;
		}

		// Stop if we've had too many consecutive parse errors
		if (this._consecutiveParseErrors >= 3) {
			return false;
		}

		return true;
	}
}
