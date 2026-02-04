/**
 * Tests for Auto-Finalize Handler
 */

import type { BaseMessage } from '@langchain/core/messages';
import { HumanMessage } from '@langchain/core/messages';
import type { WorkflowJSON, NodeJSON } from '@n8n/workflow-sdk';

import { AutoFinalizeHandler } from '../handlers/auto-finalize-handler';
import type { StreamGenerationError } from '../../types/streaming';
import type { ParseAndValidateResult } from '../types';

describe('AutoFinalizeHandler', () => {
	const mockDebugLog = jest.fn();
	const mockParseAndValidate = jest.fn<Promise<ParseAndValidateResult>, [string, WorkflowJSON?]>();
	const mockGetErrorContext = jest.fn<string, [string, string]>();

	const createHandler = () =>
		new AutoFinalizeHandler({
			parseAndValidate: mockParseAndValidate,
			getErrorContext: mockGetErrorContext,
			debugLog: mockDebugLog,
		});

	beforeEach(() => {
		jest.clearAllMocks();
		mockGetErrorContext.mockReturnValue('Error context here');
	});

	describe('execute', () => {
		it('should prompt for code creation when no code exists', async () => {
			const handler = createHandler();
			const messages: BaseMessage[] = [];
			const generationErrors: StreamGenerationError[] = [];

			const gen = handler.execute({
				code: null,
				currentWorkflow: undefined,
				iteration: 1,
				messages,
				generationErrors,
			});

			const result = await consumeGenerator(gen);

			expect(result.success).toBe(false);
			expect(result.promptedForCode).toBe(true);
			expect(messages).toHaveLength(1);
			expect((messages[0] as HumanMessage).content).toContain('text editor tool');
		});

		it('should return success with workflow when validation passes', async () => {
			const handler = createHandler();
			const messages: BaseMessage[] = [];
			const generationErrors: StreamGenerationError[] = [];

			const mockNode: NodeJSON = {
				id: '1',
				name: 'Node',
				type: 'n8n-nodes-base.set',
				position: [0, 0],
				typeVersion: 1,
			};
			const mockWorkflow: WorkflowJSON = {
				id: 'test',
				name: 'Test',
				nodes: [mockNode],
				connections: {},
			};

			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [],
			});

			const gen = handler.execute({
				code: 'const workflow = { ... }',
				currentWorkflow: undefined,
				iteration: 1,
				messages,
				generationErrors,
			});

			const result = await consumeGenerator(gen);

			expect(result.success).toBe(true);
			expect(result.workflow).toEqual(mockWorkflow);
			expect(result.sourceCode).toBe('const workflow = { ... }');
			expect(result.parseDuration).toBeGreaterThanOrEqual(0);
			expect(generationErrors).toHaveLength(0);
		});

		it('should return failure with feedback when validation has warnings', async () => {
			const handler = createHandler();
			const messages: BaseMessage[] = [];
			const generationErrors: StreamGenerationError[] = [];

			const mockWorkflow: WorkflowJSON = {
				id: 'test',
				name: 'Test',
				nodes: [],
				connections: {},
			};

			mockParseAndValidate.mockResolvedValue({
				workflow: mockWorkflow,
				warnings: [{ code: 'W001', message: 'Warning message', nodeName: 'Node1' }],
			});

			const gen = handler.execute({
				code: 'const workflow = { ... }',
				currentWorkflow: undefined,
				iteration: 1,
				messages,
				generationErrors,
			});

			const result = await consumeGenerator(gen);

			expect(result.success).toBe(false);
			expect(result.workflow).toBeUndefined();
			expect(messages).toHaveLength(1);
			expect((messages[0] as HumanMessage).content).toContain('Validation warnings');
			expect(generationErrors).toHaveLength(1);
			expect(generationErrors[0].type).toBe('validation');
		});

		it('should return failure with feedback when parsing fails', async () => {
			const handler = createHandler();
			const messages: BaseMessage[] = [];
			const generationErrors: StreamGenerationError[] = [];

			mockParseAndValidate.mockRejectedValue(new Error('Parse failed'));

			const gen = handler.execute({
				code: 'invalid code',
				currentWorkflow: undefined,
				iteration: 1,
				messages,
				generationErrors,
			});

			const result = await consumeGenerator(gen);

			expect(result.success).toBe(false);
			expect(result.workflow).toBeUndefined();
			expect(messages).toHaveLength(1);
			expect((messages[0] as HumanMessage).content).toContain('Parse error');
			expect(generationErrors).toHaveLength(1);
			expect(generationErrors[0].type).toBe('parse');
		});

		it('should track parse duration on failure', async () => {
			const handler = createHandler();
			const messages: BaseMessage[] = [];
			const generationErrors: StreamGenerationError[] = [];

			mockParseAndValidate.mockImplementation(async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				throw new Error('Parse failed');
			});

			const gen = handler.execute({
				code: 'invalid code',
				currentWorkflow: undefined,
				iteration: 1,
				messages,
				generationErrors,
			});

			const result = await consumeGenerator(gen);

			expect(result.parseDuration).toBeGreaterThanOrEqual(10);
		});
	});
});

// Helper to consume an async generator and return the final result
async function consumeGenerator<T, R>(gen: AsyncGenerator<T, R>): Promise<R> {
	let result: IteratorResult<T, R>;
	do {
		result = await gen.next();
	} while (!result.done);
	return result.value;
}
