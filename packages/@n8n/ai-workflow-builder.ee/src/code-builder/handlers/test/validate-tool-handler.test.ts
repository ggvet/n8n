/**
 * Tests for ValidateToolHandler
 */

import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage } from '@langchain/core/messages';

import { WarningTracker } from '../../state/warning-tracker';
import { ValidateToolHandler } from '../validate-tool-handler';

describe('ValidateToolHandler', () => {
	let handler: ValidateToolHandler;
	let mockParseAndValidate: jest.Mock;
	let mockGetErrorContext: jest.Mock;
	let mockDebugLog: jest.Mock;
	let messages: BaseMessage[];
	let warningTracker: WarningTracker;

	beforeEach(() => {
		mockParseAndValidate = jest.fn();
		mockGetErrorContext = jest.fn().mockReturnValue('Code context:\n1: const x = 1;');
		mockDebugLog = jest.fn();
		messages = [];
		warningTracker = new WarningTracker();

		handler = new ValidateToolHandler({
			parseAndValidate: mockParseAndValidate,
			getErrorContext: mockGetErrorContext,
			debugLog: mockDebugLog,
		});
	});

	describe('execute', () => {
		const baseParams = {
			toolCallId: 'test-id',
			code: 'const workflow = {};',
			currentWorkflow: undefined,
			iteration: 1,
		};

		it('should return workflowReady false when no code provided', async () => {
			const generator = handler.execute({
				...baseParams,
				code: null,
				messages,
				warningTracker,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should yield running and completed status
			expect(chunks.length).toBeGreaterThanOrEqual(2);

			// Should add error message to messages
			expect(messages.length).toBe(1);
			expect(messages[0]).toBeInstanceOf(ToolMessage);
		});

		it('should return workflowReady true on successful validation', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test',
				nodes: [{ id: 'n1', name: 'Node 1', type: 'test' }],
				connections: {},
			};

			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [],
			});

			const generator = handler.execute({
				...baseParams,
				messages,
				warningTracker,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should have tool running, workflow update, and tool completed
			expect(chunks.length).toBeGreaterThanOrEqual(3);

			// Should add success message to messages
			expect(messages.length).toBe(1);
			const toolMessage = messages[0] as ToolMessage;
			expect(toolMessage.content).toContain('Validation passed');
		});

		it('should return workflowReady false on validation warnings (new warnings)', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test',
				nodes: [],
				connections: {},
			};

			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [{ code: 'WARN001', message: 'Missing parameter' }],
			});

			const generator = handler.execute({
				...baseParams,
				messages,
				warningTracker,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should add warning message to messages
			expect(messages.length).toBe(1);
			const toolMessage = messages[0] as ToolMessage;
			expect(toolMessage.content).toContain('WARN001');
		});

		it('should return workflowReady true when all warnings are repeated', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test',
				nodes: [],
				connections: {},
			};

			// Pre-mark the warning as seen
			warningTracker.markAsSeen([{ code: 'WARN001', message: 'Old message' }]);

			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [{ code: 'WARN001', message: 'New message but same location' }],
			});

			const generator = handler.execute({
				...baseParams,
				messages,
				warningTracker,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should add success message (not warning) since all warnings are repeated
			expect(messages.length).toBe(1);
			const toolMessage = messages[0] as ToolMessage;
			expect(toolMessage.content).toContain('Validation passed');
		});

		it('should return workflowReady false on parse error', async () => {
			mockParseAndValidate.mockRejectedValue(new Error('Syntax error at line 5'));

			const generator = handler.execute({
				...baseParams,
				messages,
				warningTracker,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should add error message to messages
			expect(messages.length).toBe(1);
			const toolMessage = messages[0] as ToolMessage;
			expect(toolMessage.content).toContain('Parse error');
		});

		it('should yield workflow update on success', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test',
				nodes: [],
				connections: {},
			};

			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [],
			});

			const generator = handler.execute({
				...baseParams,
				messages,
				warningTracker,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Find workflow update chunk
			const workflowUpdateChunk = chunks.find((c: unknown) =>
				(c as { messages?: Array<{ type: string }> }).messages?.some(
					(m) => m.type === 'workflow-updated',
				),
			);
			expect(workflowUpdateChunk).toBeDefined();
		});

		it('should yield partial workflow update on warnings', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test',
				nodes: [],
				connections: {},
			};

			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [{ code: 'WARN001', message: 'Warning' }],
			});

			const generator = handler.execute({
				...baseParams,
				messages,
				warningTracker,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should still yield workflow update for progressive rendering
			const workflowUpdateChunk = chunks.find((c: unknown) =>
				(c as { messages?: Array<{ type: string }> }).messages?.some(
					(m) => m.type === 'workflow-updated',
				),
			);
			expect(workflowUpdateChunk).toBeDefined();
		});
	});
});
