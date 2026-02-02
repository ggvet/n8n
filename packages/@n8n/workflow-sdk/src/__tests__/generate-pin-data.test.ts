import { workflow } from '../workflow-builder';
import { node, trigger } from '../node-builder';

describe('generatePinData', () => {
	describe('basic generation', () => {
		it('uses output declaration directly as pinData', () => {
			const outputData = [{ id: 'channel-1', name: 'general' }];

			const wf = workflow('id', 'Test')
				.add(
					trigger({
						type: 'n8n-nodes-base.manualTrigger',
						version: 1,
						config: { name: 'Start' },
					}),
				)
				.then(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: {
							name: 'Slack',
							parameters: { resource: 'channel', operation: 'get' },
							output: outputData,
						},
					}),
				)
				.generatePinData();

			const json = wf.toJSON();
			expect(json.pinData).toBeDefined();
			expect(json.pinData!['Slack']).toBeDefined();
			expect(json.pinData!['Slack']).toEqual(outputData);
		});

		it('returns this for chaining', () => {
			const wf = workflow('id', 'Test');
			const result = wf.generatePinData();
			expect(result).toBe(wf);
		});

		it('silently skips nodes without output declaration', () => {
			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.noOp',
						version: 1,
						config: { name: 'No Op' },
					}),
				)
				.generatePinData();

			const json = wf.toJSON();
			// No pin data should be generated (either empty object or undefined)
			expect(json.pinData?.['No Op']).toBeUndefined();
		});

		it('skips nodes with empty output array', () => {
			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.noOp',
						version: 1,
						config: { name: 'Empty Output', output: [] },
					}),
				)
				.generatePinData();

			const json = wf.toJSON();
			expect(json.pinData?.['Empty Output']).toBeUndefined();
		});
	});

	describe('multiple items in output', () => {
		it('preserves all items from output declaration', () => {
			const outputData = [
				{ id: 'channel-1', name: 'general' },
				{ id: 'channel-2', name: 'random' },
				{ id: 'channel-3', name: 'support' },
			];

			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: {
							name: 'Slack',
							parameters: { resource: 'channel', operation: 'getAll' },
							output: outputData,
						},
					}),
				)
				.generatePinData();

			const json = wf.toJSON();
			expect(json.pinData!['Slack']).toHaveLength(3);
			expect(json.pinData!['Slack']).toEqual(outputData);
		});
	});

	describe('filtering by nodes option', () => {
		it('only generates for specified node names', () => {
			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: { name: 'Slack 1', output: [{ id: '1' }] },
					}),
				)
				.then(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: { name: 'Slack 2', output: [{ id: '2' }] },
					}),
				)
				.generatePinData({ nodes: ['Slack 1'] });

			const json = wf.toJSON();
			expect(json.pinData!['Slack 1']).toBeDefined();
			expect(json.pinData!['Slack 2']).toBeUndefined();
		});
	});

	describe('filtering by hasNoCredentials option', () => {
		it('only generates for nodes without credentials', () => {
			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: {
							name: 'With Creds',
							credentials: { slackApi: { id: '1', name: 'Slack' } },
							output: [{ id: 'cred' }],
						},
					}),
				)
				.then(
					node({
						type: 'n8n-nodes-base.code',
						version: 2,
						config: { name: 'No Creds', output: [{ id: 'nocred' }] },
					}),
				)
				.generatePinData({ hasNoCredentials: true });

			const json = wf.toJSON();
			expect(json.pinData!['With Creds']).toBeUndefined();
			expect(json.pinData!['No Creds']).toBeDefined();
		});

		it('treats empty credentials object as having no credentials', () => {
			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.code',
						version: 2,
						config: { name: 'Empty Creds', credentials: {}, output: [{ id: 'test' }] },
					}),
				)
				.generatePinData({ hasNoCredentials: true });

			const json = wf.toJSON();
			expect(json.pinData!['Empty Creds']).toBeDefined();
		});
	});

	describe('filtering by beforeWorkflow option', () => {
		it('only generates for nodes not in the before workflow', () => {
			const beforeWorkflow = {
				name: 'Before',
				nodes: [
					{
						id: '1',
						name: 'Existing Node',
						type: 'n8n-nodes-base.slack',
						typeVersion: 2,
						position: [0, 0] as [number, number],
						parameters: {},
					},
				],
				connections: {},
			};

			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: { name: 'Existing Node', output: [{ id: 'existing' }] },
					}),
				)
				.then(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: { name: 'New Node', output: [{ id: 'new' }] },
					}),
				)
				.generatePinData({ beforeWorkflow });

			const json = wf.toJSON();
			expect(json.pinData!['Existing Node']).toBeUndefined();
			expect(json.pinData!['New Node']).toBeDefined();
		});
	});

	describe('combining filters', () => {
		it('combines filters with AND logic', () => {
			const beforeWorkflow = {
				name: 'Before',
				nodes: [
					{
						id: '1',
						name: 'Old',
						type: 'n8n-nodes-base.slack',
						typeVersion: 2,
						position: [0, 0] as [number, number],
						parameters: {},
					},
				],
				connections: {},
			};

			const wf = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: { name: 'Old', output: [{ id: 'old' }] },
					}),
				)
				.then(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: {
							name: 'New With Creds',
							credentials: { slackApi: { id: '1', name: 'Slack' } },
							output: [{ id: 'newcreds' }],
						},
					}),
				)
				.then(
					node({
						type: 'n8n-nodes-base.code',
						version: 2,
						config: { name: 'New No Creds', output: [{ id: 'newnocreds' }] },
					}),
				)
				.generatePinData({ beforeWorkflow, hasNoCredentials: true });

			const json = wf.toJSON();
			// Old: filtered out by beforeWorkflow
			expect(json.pinData!['Old']).toBeUndefined();
			// New With Creds: filtered out by hasNoCredentials
			expect(json.pinData!['New With Creds']).toBeUndefined();
			// New No Creds: passes both filters
			expect(json.pinData!['New No Creds']).toBeDefined();
		});
	});

	describe('deterministic output', () => {
		it('produces same pinData when nodes have same output declarations', () => {
			const outputData = [{ id: 'test-123' }];

			const wf1 = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: { name: 'Slack', output: outputData },
					}),
				)
				.generatePinData();

			const wf2 = workflow('id', 'Test')
				.add(
					node({
						type: 'n8n-nodes-base.slack',
						version: 2,
						config: { name: 'Slack', output: outputData },
					}),
				)
				.generatePinData();

			expect(wf1.toJSON().pinData).toEqual(wf2.toJSON().pinData);
		});
	});
});
