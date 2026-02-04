/**
 * Tests for ChatState class
 */

import { HumanMessage, AIMessage } from '@langchain/core/messages';
import type { WorkflowJSON } from '@n8n/workflow-sdk';

import { ChatState } from '../chat-state';

describe('ChatState', () => {
	let state: ChatState;

	beforeEach(() => {
		state = new ChatState();
	});

	describe('initial state', () => {
		it('should start with iteration 0', () => {
			expect(state.iteration).toBe(0);
		});

		it('should start with null workflow', () => {
			expect(state.workflow).toBeNull();
		});

		it('should start with empty messages', () => {
			expect(state.messages).toHaveLength(0);
		});

		it('should start with zero tokens', () => {
			expect(state.totalInputTokens).toBe(0);
			expect(state.totalOutputTokens).toBe(0);
		});

		it('should start with zero parseDuration', () => {
			expect(state.parseDuration).toBe(0);
		});

		it('should start with zero consecutiveParseErrors', () => {
			expect(state.consecutiveParseErrors).toBe(0);
		});
	});

	describe('iteration management', () => {
		it('should increment iteration', () => {
			state.incrementIteration();
			expect(state.iteration).toBe(1);

			state.incrementIteration();
			expect(state.iteration).toBe(2);
		});
	});

	describe('token tracking', () => {
		it('should record token usage', () => {
			state.recordTokenUsage(100, 50);
			expect(state.totalInputTokens).toBe(100);
			expect(state.totalOutputTokens).toBe(50);
		});

		it('should accumulate token usage', () => {
			state.recordTokenUsage(100, 50);
			state.recordTokenUsage(200, 100);
			expect(state.totalInputTokens).toBe(300);
			expect(state.totalOutputTokens).toBe(150);
		});

		it('should calculate total tokens', () => {
			state.recordTokenUsage(100, 50);
			expect(state.totalTokens).toBe(150);
		});
	});

	describe('workflow management', () => {
		it('should set workflow', () => {
			const workflow: WorkflowJSON = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			state.setWorkflow(workflow);

			expect(state.workflow).toEqual(workflow);
		});

		it('should clear workflow', () => {
			const workflow: WorkflowJSON = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			state.setWorkflow(workflow);
			state.clearWorkflow();

			expect(state.workflow).toBeNull();
		});
	});

	describe('message management', () => {
		it('should add messages', () => {
			const message = new HumanMessage('Hello');
			state.addMessage(message);

			expect(state.messages).toHaveLength(1);
			expect(state.messages[0]).toBe(message);
		});

		it('should set initial messages', () => {
			const messages = [new HumanMessage('Hello'), new AIMessage('Hi there')];
			state.setMessages(messages);

			expect(state.messages).toHaveLength(2);
		});
	});

	describe('parse error tracking', () => {
		it('should increment consecutive parse errors', () => {
			state.incrementConsecutiveParseErrors();
			expect(state.consecutiveParseErrors).toBe(1);

			state.incrementConsecutiveParseErrors();
			expect(state.consecutiveParseErrors).toBe(2);
		});

		it('should reset consecutive parse errors', () => {
			state.incrementConsecutiveParseErrors();
			state.incrementConsecutiveParseErrors();
			state.resetConsecutiveParseErrors();

			expect(state.consecutiveParseErrors).toBe(0);
		});
	});

	describe('parseDuration', () => {
		it('should set parse duration', () => {
			state.setParseDuration(123);
			expect(state.parseDuration).toBe(123);
		});
	});

	describe('shouldContinue', () => {
		it('should return true when no workflow and under iteration limit', () => {
			expect(state.shouldContinue(50)).toBe(true);
		});

		it('should return false when workflow is set', () => {
			const workflow: WorkflowJSON = {
				id: 'test',
				name: 'Test Workflow',
				nodes: [],
				connections: {},
			};

			state.setWorkflow(workflow);

			expect(state.shouldContinue(50)).toBe(false);
		});

		it('should return false when iteration limit reached', () => {
			for (let i = 0; i < 50; i++) {
				state.incrementIteration();
			}

			expect(state.shouldContinue(50)).toBe(false);
		});

		it('should return false when too many consecutive parse errors', () => {
			state.incrementConsecutiveParseErrors();
			state.incrementConsecutiveParseErrors();
			state.incrementConsecutiveParseErrors();

			expect(state.shouldContinue(50)).toBe(false);
		});
	});

	describe('text editor state', () => {
		it('should track validate attempts', () => {
			expect(state.textEditorValidateAttempts).toBe(0);

			state.incrementTextEditorValidateAttempts();
			expect(state.textEditorValidateAttempts).toBe(1);
		});

		it('should track validate passed this iteration flag', () => {
			expect(state.validatePassedThisIteration).toBe(false);

			state.setValidatePassedThisIteration(true);
			expect(state.validatePassedThisIteration).toBe(true);
		});

		it('should reset validate passed flag', () => {
			state.setValidatePassedThisIteration(true);
			state.resetValidatePassedThisIteration();

			expect(state.validatePassedThisIteration).toBe(false);
		});
	});
});
