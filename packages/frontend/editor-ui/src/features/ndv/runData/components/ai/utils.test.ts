import type { ITaskData } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { getReferencedData } from './utils';

describe('getReferencedData', () => {
	it('filters agent input when toolInputKeys is present', () => {
		const taskData: ITaskData = {
			inputOverride: {
				ai_tool: [
					[
						{
							json: {
								prompt: 'agent input',
								chatInput: 'hello',
								query: 'tool argument',
								toolCallId: 'call_123',
							},
						},
					],
				],
			},
			data: {
				[NodeConnectionTypes.AiTool]: [[{ json: { result: 'tool output' } }]],
			},
			source: [{ previousNode: 'AI Agent' }],
			executionIndex: 0,
			executionTime: 100,
			startTime: 1000,
			metadata: { toolInputKeys: ['query', 'toolCallId'] },
		};

		const result = getReferencedData(taskData);

		// Find the input data
		const inputData = result.find((r) => r.inOut === 'input');
		expect(inputData).toBeDefined();
		expect(inputData?.data?.[0].json).toEqual({
			query: 'tool argument',
			toolCallId: 'call_123',
		});
		// Verify agent input keys are filtered out
		expect(inputData?.data?.[0].json).not.toHaveProperty('prompt');
		expect(inputData?.data?.[0].json).not.toHaveProperty('chatInput');

		// Verify output data is not affected
		const outputData = result.find((r) => r.inOut === 'output');
		expect(outputData?.data?.[0].json).toEqual({ result: 'tool output' });
	});

	it('shows all data when toolInputKeys is not present (backward compatibility)', () => {
		const taskData: ITaskData = {
			inputOverride: {
				ai_tool: [
					[
						{
							json: {
								prompt: 'agent input',
								chatInput: 'hello',
								query: 'tool argument',
							},
						},
					],
				],
			},
			data: {
				[NodeConnectionTypes.AiTool]: [[{ json: { result: 'tool output' } }]],
			},
			source: [{ previousNode: 'AI Agent' }],
			executionIndex: 0,
			executionTime: 100,
			startTime: 1000,
			// No metadata.toolInputKeys
		};

		const result = getReferencedData(taskData);

		const inputData = result.find((r) => r.inOut === 'input');
		expect(inputData).toBeDefined();
		expect(inputData?.data?.[0].json).toHaveProperty('prompt');
		expect(inputData?.data?.[0].json).toHaveProperty('chatInput');
		expect(inputData?.data?.[0].json).toHaveProperty('query');
	});

	it('handles multiple items in input data', () => {
		const taskData: ITaskData = {
			inputOverride: {
				ai_tool: [
					[
						{
							json: {
								prompt: 'first prompt',
								query: 'first query',
								toolCallId: 'call_1',
							},
						},
						{
							json: {
								prompt: 'second prompt',
								query: 'second query',
								toolCallId: 'call_2',
							},
						},
					],
				],
			},
			source: [{ previousNode: 'AI Agent' }],
			executionIndex: 0,
			executionTime: 100,
			startTime: 1000,
			metadata: { toolInputKeys: ['query', 'toolCallId'] },
		};

		const result = getReferencedData(taskData);

		const inputData = result.find((r) => r.inOut === 'input');
		expect(inputData?.data).toHaveLength(2);
		expect(inputData?.data?.[0].json).toEqual({
			query: 'first query',
			toolCallId: 'call_1',
		});
		expect(inputData?.data?.[1].json).toEqual({
			query: 'second query',
			toolCallId: 'call_2',
		});
	});

	it('preserves other item properties when filtering', () => {
		const taskData: ITaskData = {
			inputOverride: {
				ai_tool: [
					[
						{
							json: {
								prompt: 'agent input',
								query: 'tool argument',
								toolCallId: 'call_123',
							},
							binary: {
								data: { data: 'test', mimeType: 'text/plain' },
							},
							pairedItem: { item: 0 },
						},
					],
				],
			},
			source: [{ previousNode: 'AI Agent' }],
			executionIndex: 0,
			executionTime: 100,
			startTime: 1000,
			metadata: { toolInputKeys: ['query', 'toolCallId'] },
		};

		const result = getReferencedData(taskData);

		const inputData = result.find((r) => r.inOut === 'input');
		expect(inputData?.data?.[0].binary).toBeDefined();
		expect(inputData?.data?.[0].pairedItem).toEqual({ item: 0 });
	});

	it('handles empty toolInputKeys array', () => {
		const taskData: ITaskData = {
			inputOverride: {
				ai_tool: [
					[
						{
							json: {
								prompt: 'agent input',
								query: 'tool argument',
							},
						},
					],
				],
			},
			source: [{ previousNode: 'AI Agent' }],
			executionIndex: 0,
			executionTime: 100,
			startTime: 1000,
			metadata: { toolInputKeys: [] },
		};

		const result = getReferencedData(taskData);

		const inputData = result.find((r) => r.inOut === 'input');
		expect(inputData?.data?.[0].json).toEqual({});
	});

	it('handles null input data gracefully', () => {
		const taskData: ITaskData = {
			inputOverride: {
				ai_tool: [null as unknown as []],
			},
			source: [{ previousNode: 'AI Agent' }],
			executionIndex: 0,
			executionTime: 100,
			startTime: 1000,
			metadata: { toolInputKeys: ['query'] },
		};

		const result = getReferencedData(taskData);

		const inputData = result.find((r) => r.inOut === 'input');
		expect(inputData?.data).toBeNull();
	});
});
