/**
 * Tests for WorkflowBuilder plugin integration (Phase 6)
 *
 * These tests verify that the plugin system is properly integrated with
 * WorkflowBuilderImpl, allowing plugins to participate in validation,
 * composite handling, and serialization.
 */

import { workflow } from '../workflow-builder';
import { node, trigger, ifElse, switchCase } from '../node-builder';
import { splitInBatches } from '../split-in-batches';
import type { MergeComposite, NodeInstance } from '../types/base';
import { PluginRegistry } from '../plugins/registry';
import type {
	ValidatorPlugin,
	PluginContext,
	SerializerPlugin,
	CompositeHandlerPlugin,
	MutablePluginContext,
} from '../plugins/types';
import type { WorkflowJSON, IfElseComposite } from '../types/base';
import { jsonSerializer } from '../plugins/serializers/json-serializer';

// Helper to create mock validators
function createMockValidator(
	id: string,
	nodeTypes: string[] = [],
	validateNodeFn: ValidatorPlugin['validateNode'] = () => [],
): ValidatorPlugin {
	return {
		id,
		name: `Mock Validator ${id}`,
		nodeTypes,
		validateNode: jest.fn(validateNodeFn),
	};
}

describe('WorkflowBuilder plugin integration', () => {
	let testRegistry: PluginRegistry;

	beforeEach(() => {
		testRegistry = new PluginRegistry();
	});

	describe('validate() with plugins', () => {
		it('runs registered validators for matching node types', () => {
			const mockValidateNode = jest.fn().mockReturnValue([]);
			const mockValidator = createMockValidator(
				'test:mock',
				['n8n-nodes-base.set'],
				mockValidateNode,
			);
			testRegistry.registerValidator(mockValidator);

			const setNode = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'Set Data', parameters: { values: [] } },
			});

			const wf = workflow('test', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).then(setNode),
			);

			wf.validate();

			expect(mockValidateNode).toHaveBeenCalled();
		});

		it('collects issues from all matching validators', () => {
			const validator1 = createMockValidator('test:v1', [], () => [
				{ code: 'V1_ISSUE', message: 'Issue 1', severity: 'warning' },
			]);
			const validator2 = createMockValidator('test:v2', [], () => [
				{ code: 'V2_ISSUE', message: 'Issue 2', severity: 'error' },
			]);
			testRegistry.registerValidator(validator1);
			testRegistry.registerValidator(validator2);

			const wf = workflow('test', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}),
			);

			const result = wf.validate();

			// Cast to any to allow checking custom plugin codes
			expect(result.warnings.some((w) => (w.code as string) === 'V1_ISSUE')).toBe(true);
			expect(result.errors.some((e) => (e.code as string) === 'V2_ISSUE')).toBe(true);
		});

		it('validators receive correct PluginContext', () => {
			let receivedCtx: PluginContext | undefined;
			const mockValidator = createMockValidator('test:ctx', [], (_node, _graphNode, ctx) => {
				receivedCtx = ctx;
				return [];
			});
			testRegistry.registerValidator(mockValidator);

			const wf = workflow('wf-123', 'My Workflow', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}),
			);

			wf.validate();

			expect(receivedCtx).toBeDefined();
			expect(receivedCtx!.workflowId).toBe('wf-123');
			expect(receivedCtx!.workflowName).toBe('My Workflow');
			expect(receivedCtx!.nodes).toBeDefined();
		});

		it('validateWorkflow() hook is called after node validation', () => {
			const callOrder: string[] = [];
			const mockValidator: ValidatorPlugin = {
				id: 'test:hooks',
				name: 'Hook Validator',
				validateNode: () => {
					callOrder.push('validateNode');
					return [];
				},
				validateWorkflow: () => {
					callOrder.push('validateWorkflow');
					return [];
				},
			};
			testRegistry.registerValidator(mockValidator);

			const wf = workflow('test', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}),
			);

			wf.validate();

			expect(callOrder).toContain('validateNode');
			expect(callOrder).toContain('validateWorkflow');
			// validateWorkflow should be called after all validateNode calls
			const nodeIdx = callOrder.indexOf('validateNode');
			const workflowIdx = callOrder.indexOf('validateWorkflow');
			expect(workflowIdx).toBeGreaterThan(nodeIdx);
		});

		it('skips validators that do not match node type', () => {
			const agentValidator = createMockValidator(
				'test:agent',
				['@n8n/n8n-nodes-langchain.agent'],
				() => [{ code: 'AGENT_ISSUE', message: 'Agent issue', severity: 'warning' }],
			);
			testRegistry.registerValidator(agentValidator);

			// Add a non-agent node
			const wf = workflow('test', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}),
			);

			const result = wf.validate();

			// Agent validator should not have been called
			expect(agentValidator.validateNode).not.toHaveBeenCalled();
			expect(result.warnings.some((w) => (w.code as string) === 'AGENT_ISSUE')).toBe(false);
		});

		it('validators with empty nodeTypes run on all nodes', () => {
			const universalValidator = createMockValidator('test:universal', [], () => []);
			testRegistry.registerValidator(universalValidator);

			const wf = workflow('test', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).then(
					node({
						type: 'n8n-nodes-base.set',
						version: 3.4,
						config: { name: 'Set' },
					}),
				),
			);

			wf.validate();

			// Should be called once for each node (2 nodes)
			expect(universalValidator.validateNode).toHaveBeenCalledTimes(2);
		});
	});

	describe('toFormat()', () => {
		it('returns serialized output for registered format', () => {
			testRegistry.registerSerializer(jsonSerializer);

			const wf = workflow('wf-1', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}),
			);

			const result = wf.toFormat<WorkflowJSON>('json');

			expect(result.id).toBe('wf-1');
			expect(result.name).toBe('Test');
		});

		it('throws for unknown format', () => {
			const wf = workflow('test', 'Test', { registry: testRegistry });

			expect(() => wf.toFormat('yaml')).toThrow("No serializer registered for format 'yaml'");
		});

		it('custom serializer can transform workflow', () => {
			const customSerializer: SerializerPlugin<string> = {
				id: 'test:custom',
				name: 'Custom Serializer',
				format: 'custom',
				serialize: (ctx) => `Workflow: ${ctx.workflowName} (${ctx.nodes.size} nodes)`,
			};
			testRegistry.registerSerializer(customSerializer);

			const wf = workflow('test', 'My Flow', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}),
			);

			const result = wf.toFormat<string>('custom');

			expect(result).toBe('Workflow: My Flow (1 nodes)');
		});
	});

	describe('workflow() factory with registry option', () => {
		it('accepts registry option', () => {
			const customRegistry = new PluginRegistry();
			const wf = workflow('test', 'Test', { registry: customRegistry });

			// Should not throw
			expect(wf).toBeDefined();
		});

		it('uses provided registry for validation', () => {
			const customRegistry = new PluginRegistry();
			const mockValidator = createMockValidator('custom:v1', [], () => [
				{ code: 'CUSTOM_ISSUE', message: 'Custom issue', severity: 'warning' },
			]);
			customRegistry.registerValidator(mockValidator);

			const wf = workflow('test', 'Test', { registry: customRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}),
			);

			const result = wf.validate();

			expect(result.warnings.some((w) => (w.code as string) === 'CUSTOM_ISSUE')).toBe(true);
		});

		it('accepts both settings and registry', () => {
			const customRegistry = new PluginRegistry();
			const wf = workflow('test', 'Test', {
				settings: { timezone: 'UTC' },
				registry: customRegistry,
			});

			const json = wf.toJSON();
			expect(json.settings?.timezone).toBe('UTC');
		});
	});

	describe('add() with composite handlers', () => {
		it('delegates IfElseComposite to registered handler when handler handles it', () => {
			const mockAddNodes = jest.fn().mockReturnValue('If Node');
			const mockHandler: CompositeHandlerPlugin<IfElseComposite> = {
				id: 'test:if-else',
				name: 'Test If/Else Handler',
				priority: 100,
				canHandle: (input): input is IfElseComposite =>
					input !== null &&
					typeof input === 'object' &&
					'_isIfElseBuilder' in input &&
					(input as { _isIfElseBuilder: boolean })._isIfElseBuilder === true,
				addNodes: mockAddNodes,
			};
			testRegistry.registerCompositeHandler(mockHandler);

			// Create an IfElseComposite using the ifElse builder
			const trueNode = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'True Branch', parameters: {} },
			});
			const falseNode = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'False Branch', parameters: {} },
			});

			const composite = ifElse({ version: 2, config: { name: 'If Node', parameters: {} } }).onTrue!(
				trueNode,
			).onFalse(falseNode);

			// Add the composite to the workflow
			workflow('test', 'Test', { registry: testRegistry }).add(composite);

			// Verify the handler was called
			expect(mockAddNodes).toHaveBeenCalled();
		});

		it('uses global pluginRegistry as fallback when custom registry has no handler', () => {
			// Custom registry has no handlers, but global pluginRegistry does
			// The workflow should use global pluginRegistry as fallback
			const trueNode = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'True Branch', parameters: {} },
			});
			const falseNode = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'False Branch', parameters: {} },
			});

			const composite = ifElse({ version: 2, config: { name: 'If Node', parameters: {} } }).onTrue!(
				trueNode,
			).onFalse(falseNode);

			// Create workflow without a custom registry - uses global pluginRegistry
			const wf = workflow('test', 'Test').add(composite);

			// Verify all nodes were added (global pluginRegistry has core:if-else handler)
			const json = wf.toJSON();
			expect(json.nodes).toHaveLength(3);
			expect(json.nodes.map((n) => n.name)).toContain('If Node');
			expect(json.nodes.map((n) => n.name)).toContain('True Branch');
			expect(json.nodes.map((n) => n.name)).toContain('False Branch');
		});

		it('handler receives MutablePluginContext with helper methods', () => {
			let receivedCtx: MutablePluginContext | undefined;
			const mockHandler: CompositeHandlerPlugin<IfElseComposite> = {
				id: 'test:ctx-checker',
				name: 'Context Checker Handler',
				priority: 100,
				canHandle: (input): input is IfElseComposite =>
					input !== null &&
					typeof input === 'object' &&
					'_isIfElseBuilder' in input &&
					(input as { _isIfElseBuilder: boolean })._isIfElseBuilder === true,
				addNodes: (input, ctx) => {
					receivedCtx = ctx;
					// Actually add the if node so workflow doesn't fail
					ctx.addNodeWithSubnodes(input.ifNode);
					return input.ifNode.name;
				},
			};
			testRegistry.registerCompositeHandler(mockHandler);

			const composite = ifElse({ version: 2, config: { name: 'If Node', parameters: {} } }).onTrue!(
				null,
			).onFalse(null);

			workflow('wf-123', 'My Workflow', { registry: testRegistry }).add(composite);

			expect(receivedCtx).toBeDefined();
			expect(receivedCtx!.workflowId).toBe('wf-123');
			expect(receivedCtx!.workflowName).toBe('My Workflow');
			expect(typeof receivedCtx!.addNodeWithSubnodes).toBe('function');
			expect(typeof receivedCtx!.addBranchToGraph).toBe('function');
		});
	});

	describe('then() with composite handlers', () => {
		it('delegates IfElseComposite to registered handler in then()', () => {
			const mockAddNodes = jest.fn().mockImplementation((input: IfElseComposite, ctx) => {
				ctx.addNodeWithSubnodes(input.ifNode);
				return input.ifNode.name;
			});
			const mockHandler: CompositeHandlerPlugin<IfElseComposite> = {
				id: 'test:if-else',
				name: 'Test If/Else Handler',
				priority: 100,
				canHandle: (input): input is IfElseComposite =>
					input !== null &&
					typeof input === 'object' &&
					'_isIfElseBuilder' in input &&
					(input as { _isIfElseBuilder: boolean })._isIfElseBuilder === true,
				addNodes: mockAddNodes,
			};
			testRegistry.registerCompositeHandler(mockHandler);

			const startTrigger = trigger({
				type: 'n8n-nodes-base.manualTrigger',
				version: 1,
				config: { name: 'Start' },
			});
			const composite = ifElse({ version: 2, config: { name: 'If Node', parameters: {} } }).onTrue!(
				null,
			).onFalse(null);

			workflow('test', 'Test', { registry: testRegistry }).add(startTrigger).then(composite);

			expect(mockAddNodes).toHaveBeenCalled();
		});
	});

	describe('Phase 6.6.1: Unconditional composite handler dispatch', () => {
		it('uses global pluginRegistry.findCompositeHandler when no registry is provided', () => {
			// Import the global registry to spy on it
			const { pluginRegistry } = require('../plugins/registry');

			// Spy on the global registry's findCompositeHandler method
			const findCompositeHandlerSpy = jest.spyOn(pluginRegistry, 'findCompositeHandler');

			// Create a workflow WITHOUT explicitly passing a registry
			// Use ifElse composite which should trigger findCompositeHandler
			const trueBranch = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'True Branch', parameters: {} },
			});
			const falseBranch = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'False Branch', parameters: {} },
			});

			const composite = ifElse({
				version: 2,
				config: { name: 'If Node', parameters: {} },
			}).onTrue!(trueBranch).onFalse(falseBranch);

			// Create workflow without registry option
			workflow('test', 'Test').add(composite);

			// The global pluginRegistry.findCompositeHandler should have been called
			expect(findCompositeHandlerSpy).toHaveBeenCalled();

			// Restore the spy
			findCompositeHandlerSpy.mockRestore();
		});

		it('uses global pluginRegistry.findCompositeHandler in then() when no registry is provided', () => {
			const { pluginRegistry } = require('../plugins/registry');
			const findCompositeHandlerSpy = jest.spyOn(pluginRegistry, 'findCompositeHandler');

			const startTrigger = trigger({
				type: 'n8n-nodes-base.manualTrigger',
				version: 1,
				config: { name: 'Start' },
			});

			const composite = ifElse({
				version: 2,
				config: { name: 'If Node', parameters: {} },
			}).onTrue!(null).onFalse(null);

			// Create workflow without registry option and use then()
			workflow('test', 'Test').add(startTrigger).then(composite);

			expect(findCompositeHandlerSpy).toHaveBeenCalled();
			findCompositeHandlerSpy.mockRestore();
		});
	});

	describe('Phase 6.5: No duplicate validation', () => {
		it('validates each node exactly once per validator (no duplicates)', () => {
			// This test verifies that validation is not duplicated
			// After Phase 6.5, plugin validators run INSTEAD of inline checks, not in addition
			const validateCallCounts: Map<string, number> = new Map();

			const countingValidator: ValidatorPlugin = {
				id: 'test:counter',
				name: 'Counting Validator',
				nodeTypes: ['n8n-nodes-base.set'],
				validateNode: (nodeInstance) => {
					const nodeName = nodeInstance.name;
					validateCallCounts.set(nodeName, (validateCallCounts.get(nodeName) ?? 0) + 1);
					return [];
				},
			};
			testRegistry.registerValidator(countingValidator);

			const setNode = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'Set Data', parameters: { values: [] } },
			});

			const wf = workflow('test', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).then(setNode),
			);

			wf.validate();

			// The Set node should be validated exactly ONCE by the plugin validator
			// If the old inline checks are still running, this would be called twice
			expect(validateCallCounts.get('Set Data')).toBe(1);
		});

		it('uses global plugin registry when no registry is provided', () => {
			// Import the global registry to add a test validator
			const { pluginRegistry } = require('../plugins/registry');
			const { registerDefaultPlugins } = require('../plugins/defaults');

			// Ensure default plugins are registered
			registerDefaultPlugins(pluginRegistry);

			// Create a workflow WITHOUT explicitly passing a registry
			const wf = workflow('test', 'Test').add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).then(
					node({
						type: '@n8n/n8n-nodes-langchain.agent',
						version: 1.7,
						config: {
							name: 'Agent',
							parameters: {
								promptType: 'define',
								text: 'static prompt without expression', // This should trigger AGENT_STATIC_PROMPT
							},
						},
					}),
				),
			);

			const result = wf.validate();

			// The agentValidator plugin should run and detect the static prompt
			expect(result.warnings.some((w) => w.code === 'AGENT_STATIC_PROMPT')).toBe(true);
		});

		it('inline check methods do not duplicate plugin validation warnings', () => {
			// This test ensures that when a custom registry with plugins is used,
			// the inline check* methods are NOT called (they are replaced by plugins)

			// Create a registry with the agent validator
			const { agentValidator } = require('../plugins/validators/agent-validator');
			testRegistry.registerValidator(agentValidator);

			// Create an agent node with issues that both inline and plugin would catch
			const agentNode = node({
				type: '@n8n/n8n-nodes-langchain.agent',
				version: 1.7,
				config: {
					name: 'Agent',
					parameters: {
						promptType: 'define',
						text: 'static prompt', // No expression - triggers warning
						options: {}, // No systemMessage - triggers warning
					},
				},
			});

			const wf = workflow('test', 'Test', { registry: testRegistry }).add(
				trigger({
					type: 'n8n-nodes-base.manualTrigger',
					version: 1,
					config: { name: 'Start' },
				}).then(agentNode),
			);

			const result = wf.validate();

			// Count warnings of each type - should be exactly 1, not 2 (no duplicates)
			const staticPromptWarnings = result.warnings.filter((w) => w.code === 'AGENT_STATIC_PROMPT');
			const noSystemMessageWarnings = result.warnings.filter(
				(w) => w.code === 'AGENT_NO_SYSTEM_MESSAGE',
			);

			// Each warning should appear exactly once (from plugin only, not duplicated)
			expect(staticPromptWarnings.length).toBe(1);
			expect(noSystemMessageWarnings.length).toBe(1);
		});
	});

	describe('Phase 6.6.5: Verify plugin handlers are used for all composite types', () => {
		it('ifElse builder is handled by global pluginRegistry handler', () => {
			const { pluginRegistry } = require('../plugins/registry');
			const { registerDefaultPlugins } = require('../plugins/defaults');
			registerDefaultPlugins(pluginRegistry);

			const findHandlerSpy = jest.spyOn(pluginRegistry, 'findCompositeHandler');

			const trueBranch = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'True', parameters: {} },
			});
			const composite = ifElse({ version: 2, config: { name: 'If', parameters: {} } }).onTrue!(
				trueBranch,
			).onFalse(null);

			// Use workflow without custom registry - uses global pluginRegistry
			const wf = workflow('test', 'Test').add(composite);

			// Verify handler was found (may be called multiple times, find the one that returned a handler)
			expect(findHandlerSpy).toHaveBeenCalled();
			const foundHandler = findHandlerSpy.mock.results.find((r) => r.value?.id === 'core:if-else');
			expect(foundHandler).toBeDefined();
			expect(foundHandler!.value.id).toBe('core:if-else');

			// Verify workflow was built correctly
			const json = wf.toJSON();
			expect(json.nodes.map((n) => n.name)).toContain('If');
			expect(json.nodes.map((n) => n.name)).toContain('True');

			findHandlerSpy.mockRestore();
		});

		it('switchCase builder is handled by global pluginRegistry handler', () => {
			const { pluginRegistry } = require('../plugins/registry');
			const { registerDefaultPlugins } = require('../plugins/defaults');
			registerDefaultPlugins(pluginRegistry);

			const findHandlerSpy = jest.spyOn(pluginRegistry, 'findCompositeHandler');

			const case0 = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'Case 0', parameters: {} },
			});
			// Use the switchCase factory function syntax
			const switchNode = switchCase({
				version: 3,
				config: { name: 'Switch', parameters: {} },
			});
			const composite = switchNode.onCase!(0, case0);

			const wf = workflow('test', 'Test').add(composite);

			// Verify handler was found
			const foundHandler = findHandlerSpy.mock.results.find(
				(r) => r.value?.id === 'core:switch-case',
			);
			expect(foundHandler).toBeDefined();

			// Verify workflow was built correctly
			const json = wf.toJSON();
			expect(json.nodes.map((n) => n.name)).toContain('Switch');
			expect(json.nodes.map((n) => n.name)).toContain('Case 0');

			findHandlerSpy.mockRestore();
		});

		it('merge composite is handled by global pluginRegistry handler', () => {
			const { pluginRegistry } = require('../plugins/registry');
			const { registerDefaultPlugins } = require('../plugins/defaults');
			registerDefaultPlugins(pluginRegistry);

			const findHandlerSpy = jest.spyOn(pluginRegistry, 'findCompositeHandler');

			const mergeNodeInstance = node({
				type: 'n8n-nodes-base.merge',
				version: 3,
				config: { name: 'Merge', parameters: {} },
			});
			const branch1 = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'Branch 1', parameters: {} },
			});
			const branch2 = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'Branch 2', parameters: {} },
			});
			// Create a MergeComposite directly (with required structure: mergeNode + branches)
			const composite = {
				mergeNode: mergeNodeInstance,
				branches: [branch1, branch2],
				mode: 'combine' as const,
			} as MergeComposite<NodeInstance<string, string, unknown>[]>;

			const wf = workflow('test', 'Test').add(
				composite as unknown as NodeInstance<string, string, unknown>,
			);

			// Verify handler was found - merge handler should be called
			const foundHandler = findHandlerSpy.mock.results.find((r) => r.value?.id === 'core:merge');
			expect(foundHandler).toBeDefined();

			// Verify workflow was built correctly
			const json = wf.toJSON();
			expect(json.nodes.map((n) => n.name)).toContain('Merge');
			expect(json.nodes.map((n) => n.name)).toContain('Branch 1');
			expect(json.nodes.map((n) => n.name)).toContain('Branch 2');

			findHandlerSpy.mockRestore();
		});

		it('splitInBatches builder is handled by global pluginRegistry handler', () => {
			const { pluginRegistry } = require('../plugins/registry');
			const { registerDefaultPlugins } = require('../plugins/defaults');
			registerDefaultPlugins(pluginRegistry);

			const findHandlerSpy = jest.spyOn(pluginRegistry, 'findCompositeHandler');

			const doneNode = node({
				type: 'n8n-nodes-base.set',
				version: 3.4,
				config: { name: 'Done', parameters: {} },
			});
			const sib = splitInBatches({ version: 3 }).onDone(doneNode);

			const wf = workflow('test', 'Test').add(
				sib as unknown as NodeInstance<string, string, unknown>,
			);

			// Verify handler was found
			const foundHandler = findHandlerSpy.mock.results.find(
				(r) => r.value?.id === 'core:split-in-batches',
			);
			expect(foundHandler).toBeDefined();

			// Verify workflow was built correctly
			const json = wf.toJSON();
			expect(json.nodes.map((n) => n.name)).toContain('Split In Batches');
			expect(json.nodes.map((n) => n.name)).toContain('Done');

			findHandlerSpy.mockRestore();
		});
	});
});
