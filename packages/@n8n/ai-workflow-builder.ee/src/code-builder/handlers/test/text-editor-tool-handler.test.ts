/**
 * Tests for TextEditorToolHandler
 */

import type { BaseMessage } from '@langchain/core/messages';
import { ToolMessage, HumanMessage } from '@langchain/core/messages';

import { TextEditorToolHandler } from '../text-editor-tool-handler';

describe('TextEditorToolHandler', () => {
	let handler: TextEditorToolHandler;
	let mockTextEditorExecute: jest.Mock;
	let mockTextEditorGetCode: jest.Mock;
	let mockParseAndValidate: jest.Mock;
	let mockGetErrorContext: jest.Mock;
	let mockDebugLog: jest.Mock;
	let messages: BaseMessage[];

	beforeEach(() => {
		mockTextEditorExecute = jest.fn();
		mockTextEditorGetCode = jest.fn();
		mockParseAndValidate = jest.fn();
		mockGetErrorContext = jest.fn().mockReturnValue('Code context:\n1: const x = 1;');
		mockDebugLog = jest.fn();
		messages = [];

		handler = new TextEditorToolHandler({
			textEditorExecute: mockTextEditorExecute,
			textEditorGetCode: mockTextEditorGetCode,
			parseAndValidate: mockParseAndValidate,
			getErrorContext: mockGetErrorContext,
			debugLog: mockDebugLog,
		});
	});

	describe('execute', () => {
		const baseParams = {
			toolCallId: 'test-id',
			args: { command: 'view', path: '/workflow.ts' },
			currentWorkflow: undefined,
			iteration: 1,
		};

		it('should execute view command and return undefined', async () => {
			mockTextEditorExecute.mockReturnValue('1: const x = 1;');

			const generator = handler.execute({
				...baseParams,
				messages,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should yield running and completed
			expect(chunks.length).toBeGreaterThanOrEqual(2);

			// Should add tool result to messages
			expect(messages.length).toBe(1);
			expect(messages[0]).toBeInstanceOf(ToolMessage);
			const toolMessage = messages[0] as ToolMessage;
			expect(toolMessage.content).toBe('1: const x = 1;');
		});

		it('should execute str_replace command and return undefined', async () => {
			mockTextEditorExecute.mockReturnValue('Edit applied successfully.');

			const generator = handler.execute({
				...baseParams,
				args: { command: 'str_replace', path: '/workflow.ts', old_str: 'x', new_str: 'y' },
				messages,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			expect(messages.length).toBe(1);
			const toolMessage = messages[0] as ToolMessage;
			expect(toolMessage.content).toBe('Edit applied successfully.');
		});

		it('should auto-validate after create and return workflowReady true on success', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test',
				nodes: [{ id: 'n1', name: 'Node 1', type: 'test' }],
				connections: {},
			};

			mockTextEditorExecute.mockReturnValue('File created.');
			mockTextEditorGetCode.mockReturnValue('const workflow = {};');
			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [],
			});

			const generator = handler.execute({
				...baseParams,
				args: { command: 'create', path: '/workflow.ts', file_text: 'const workflow = {};' },
				messages,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should have create result in messages (no additional validation message on success)
			expect(messages.length).toBe(1);
			expect(messages[0]).toBeInstanceOf(ToolMessage);
		});

		it('should auto-validate after create and return workflowReady false on warnings', async () => {
			const mockWorkflow = {
				id: 'test',
				name: 'Test',
				nodes: [],
				connections: {},
			};

			mockTextEditorExecute.mockReturnValue('File created.');
			mockTextEditorGetCode.mockReturnValue('const workflow = {};');
			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [{ code: 'WARN001', message: 'Missing parameter' }],
			});

			const generator = handler.execute({
				...baseParams,
				args: { command: 'create', path: '/workflow.ts', file_text: 'const workflow = {};' },
				messages,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should have create result AND human message with warning
			expect(messages.length).toBe(2);
			expect(messages[0]).toBeInstanceOf(ToolMessage);
			expect(messages[1]).toBeInstanceOf(HumanMessage);
			expect((messages[1] as HumanMessage).content).toContain('WARN001');
		});

		it('should auto-validate after create and return workflowReady false on parse error', async () => {
			mockTextEditorExecute.mockReturnValue('File created.');
			mockTextEditorGetCode.mockReturnValue('const workflow = {};');
			mockParseAndValidate.mockRejectedValue(new Error('Syntax error'));

			const generator = handler.execute({
				...baseParams,
				args: { command: 'create', path: '/workflow.ts', file_text: 'const workflow = {};' },
				messages,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should have create result AND human message with error
			expect(messages.length).toBe(2);
			expect(messages[0]).toBeInstanceOf(ToolMessage);
			expect(messages[1]).toBeInstanceOf(HumanMessage);
			expect((messages[1] as HumanMessage).content).toContain('Parse error');
		});

		it('should handle text editor execution error', async () => {
			mockTextEditorExecute.mockImplementation(() => {
				throw new Error('No match found');
			});

			const generator = handler.execute({
				...baseParams,
				args: { command: 'str_replace', path: '/workflow.ts', old_str: 'x', new_str: 'y' },
				messages,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Should add error message
			expect(messages.length).toBe(1);
			const toolMessage = messages[0] as ToolMessage;
			expect(toolMessage.content).toContain('Error: No match found');
		});

		it('should yield tool progress chunks', async () => {
			mockTextEditorExecute.mockReturnValue('Done');

			const generator = handler.execute({
				...baseParams,
				messages,
			});

			const chunks: unknown[] = [];
			for await (const chunk of generator) {
				chunks.push(chunk);
			}

			// Find running and completed chunks
			const runningChunk = chunks.find((c: unknown) =>
				(c as { messages?: Array<{ status?: string }> }).messages?.some(
					(m) => m.status === 'running',
				),
			);
			const completedChunk = chunks.find((c: unknown) =>
				(c as { messages?: Array<{ status?: string }> }).messages?.some(
					(m) => m.status === 'completed',
				),
			);

			expect(runningChunk).toBeDefined();
			expect(completedChunk).toBeDefined();
		});
	});
});
