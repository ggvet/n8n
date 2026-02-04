import { createHash } from 'crypto';
import { workflow } from '../workflow-builder';
import { node, trigger } from '../node-builder';
import { parseWorkflowCodeToBuilder, generateWorkflowCode } from '../index';

/**
 * Generate a deterministic UUID based on workflow ID, node type, and node name.
 * This is the function signature we expect to implement.
 */
function generateDeterministicNodeId(
	workflowId: string,
	nodeType: string,
	nodeName: string,
): string {
	const hash = createHash('sha256')
		.update(`${workflowId}:${nodeType}:${nodeName}`)
		.digest('hex')
		.slice(0, 32);

	// Format as valid UUID v4 structure
	return [
		hash.slice(0, 8),
		hash.slice(8, 12),
		'4' + hash.slice(13, 16), // Version 4
		((parseInt(hash[16], 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20), // Variant
		hash.slice(20, 32),
	].join('-');
}

describe('Deterministic Node ID Generation', () => {
	describe('generateDeterministicNodeId', () => {
		it('should produce same ID for same inputs', () => {
			const id1 = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.httpRequest', 'Fetch Data');
			const id2 = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.httpRequest', 'Fetch Data');
			expect(id1).toBe(id2);
		});

		it('should produce different IDs for different workflow IDs', () => {
			const id1 = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.httpRequest', 'Fetch Data');
			const id2 = generateDeterministicNodeId('wf-456', 'n8n-nodes-base.httpRequest', 'Fetch Data');
			expect(id1).not.toBe(id2);
		});

		it('should produce different IDs for different node types', () => {
			const id1 = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.httpRequest', 'Process');
			const id2 = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.set', 'Process');
			expect(id1).not.toBe(id2);
		});

		it('should produce different IDs for different node names', () => {
			const id1 = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.httpRequest', 'Fetch Data');
			const id2 = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.httpRequest', 'Send Data');
			expect(id1).not.toBe(id2);
		});

		it('should produce valid UUID format', () => {
			const id = generateDeterministicNodeId('wf-123', 'n8n-nodes-base.httpRequest', 'Test');
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		});
	});

	describe('WorkflowBuilder.regenerateNodeIds()', () => {
		it('should regenerate node IDs deterministically', () => {
			const wf = workflow('test-workflow-id', 'Test Workflow').add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).to(node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Set Data' } })),
			);

			// Regenerate IDs deterministically
			wf.regenerateNodeIds();
			const json = wf.toJSON();

			// Check that IDs are now deterministic
			const startNode = json.nodes.find((n) => n.name === 'Start');
			const setNode = json.nodes.find((n) => n.name === 'Set Data');

			expect(startNode?.id).toBe(
				generateDeterministicNodeId('test-workflow-id', 'n8n-nodes-base.manualTrigger', 'Start'),
			);
			expect(setNode?.id).toBe(
				generateDeterministicNodeId('test-workflow-id', 'n8n-nodes-base.set', 'Set Data'),
			);
		});

		it('should update connections to use new IDs', () => {
			const wf = workflow('test-workflow-id', 'Test Workflow').add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).to(node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Set Data' } })),
			);

			wf.regenerateNodeIds();
			const json = wf.toJSON();

			// Verify connections use the correct node references
			const startConnections = json.connections['Start'];
			expect(startConnections).toBeDefined();
			expect(startConnections?.main?.[0]?.[0]?.node).toBe('Set Data');
		});

		it('should produce same IDs when called multiple times', () => {
			const wf = workflow('test-workflow-id', 'Test Workflow').add(
				trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } }),
			);

			wf.regenerateNodeIds();
			const json1 = wf.toJSON();
			const id1 = json1.nodes[0].id;

			// Create the same workflow again and regenerate
			const wf2 = workflow('test-workflow-id', 'Test Workflow').add(
				trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } }),
			);
			wf2.regenerateNodeIds();
			const json2 = wf2.toJSON();
			const id2 = json2.nodes[0].id;

			expect(id1).toBe(id2);
		});

		it('should replace existing random ID with deterministic ID', () => {
			// This test verifies that regenerateNodeIds() replaces existing random IDs
			// with deterministic ones based on workflow ID, node type, and node name
			const code = `
const start = trigger({ type: 'n8n-nodes-base.manualTrigger', version: 1, config: { name: 'Start' } });
const wf = workflow('existing-workflow', 'Existing');
return wf.add(start);
			`;
			const builder = parseWorkflowCodeToBuilder(code);

			// Get the original ID before regeneration
			const jsonBefore = builder.toJSON();
			const originalId = jsonBefore.nodes[0].id;

			// Regenerate IDs - this should create deterministic IDs
			builder.regenerateNodeIds();
			const jsonAfter = builder.toJSON();

			// The ID should now be deterministic, not the original random one
			const expectedId = generateDeterministicNodeId(
				'existing-workflow',
				'n8n-nodes-base.manualTrigger',
				'Start',
			);
			expect(jsonAfter.nodes[0].id).toBe(expectedId);
			expect(jsonAfter.nodes[0].id).not.toBe(originalId);
		});
	});

	describe('Roundtrip with deterministic IDs', () => {
		it('should produce same IDs after code regeneration and reparse', () => {
			// Create workflow
			const wf1 = workflow('roundtrip-test', 'Roundtrip Test').add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).to(node({ type: 'n8n-nodes-base.set', version: 3.4, config: { name: 'Process' } })),
			);

			wf1.regenerateNodeIds();
			const json1 = wf1.toJSON();

			// Generate code from the workflow
			const code = generateWorkflowCode(json1);

			// Parse the code back to a builder
			const wf2 = parseWorkflowCodeToBuilder(code);
			wf2.regenerateNodeIds();
			const json2 = wf2.toJSON();

			// IDs should be the same
			expect(json2.nodes[0].id).toBe(json1.nodes[0].id);
			expect(json2.nodes[1].id).toBe(json1.nodes[1].id);
		});
	});
});
