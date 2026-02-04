import type {
	WorkflowBuilder,
	WorkflowBuilderStatic,
	WorkflowSettings,
	WorkflowJSON,
	NodeInstance,
	ConnectionTarget,
	GraphNode,
	SubnodeConfig,
	IDataObject,
	NodeChain,
	CredentialReference,
	NewCredentialValue,
	GeneratePinDataOptions,
	WorkflowBuilderOptions,
} from './types/base';
import { pluginRegistry, type PluginRegistry } from './plugins/registry';
import { registerDefaultPlugins } from './plugins/defaults';
import { jsonSerializer } from './plugins/serializers';
import type {
	PluginContext,
	MutablePluginContext,
	ValidationIssue,
	SerializerContext,
} from './plugins/types';

// Ensure default plugins are registered on module load
registerDefaultPlugins(pluginRegistry);
import { isNodeChain } from './types/base';
import { isInputTarget, cloneNodeWithId } from './node-builder';
import { generateDeterministicNodeId } from './workflow-builder/string-utils';
import { shouldGeneratePinData } from './workflow-builder/pin-data-utils';

/**
 * Internal workflow builder implementation
 */
class WorkflowBuilderImpl implements WorkflowBuilder {
	readonly id: string;
	readonly name: string;
	private _settings: WorkflowSettings;
	private _nodes: Map<string, GraphNode>;
	private _currentNode: string | null;
	private _currentOutput: number;
	private _pinData?: Record<string, IDataObject[]>;
	private _meta?: { templateId?: string; instanceId?: string; [key: string]: unknown };
	private _registry?: PluginRegistry;

	constructor(
		id: string,
		name: string,
		settings: WorkflowSettings = {},
		nodes?: Map<string, GraphNode>,
		currentNode?: string | null,
		pinData?: Record<string, IDataObject[]>,
		meta?: { templateId?: string; instanceId?: string; [key: string]: unknown },
		registry?: PluginRegistry,
	) {
		this.id = id;
		this.name = name;
		this._settings = { ...settings };
		this._nodes = nodes ? new Map(nodes) : new Map();
		this._currentNode = currentNode ?? null;
		this._currentOutput = 0;
		this._pinData = pinData;
		this._meta = meta;
		this._registry = registry;
	}

	private clone(overrides: {
		nodes?: Map<string, GraphNode>;
		currentNode?: string | null;
		currentOutput?: number;
		settings?: WorkflowSettings;
		pinData?: Record<string, IDataObject[]>;
	}): WorkflowBuilderImpl {
		const builder = new WorkflowBuilderImpl(
			this.id,
			this.name,
			overrides.settings ?? this._settings,
			overrides.nodes ?? this._nodes,
			overrides.currentNode !== undefined ? overrides.currentNode : this._currentNode,
			overrides.pinData ?? this._pinData,
			this._meta,
			this._registry,
		);
		builder._currentOutput = overrides.currentOutput ?? this._currentOutput;
		return builder;
	}

	/**
	 * Create a MutablePluginContext for composite handlers.
	 * This provides helper methods that allow plugins to add nodes to the graph.
	 * @param nodes The mutable nodes map
	 * @param nameMapping Optional map to track node ID → actual map key for renamed nodes
	 */
	private createMutablePluginContext(
		nodes: Map<string, GraphNode>,
		nameMapping?: Map<string, string>,
	): MutablePluginContext {
		const effectiveNameMapping = nameMapping ?? new Map<string, string>();

		return {
			nodes,
			workflowId: this.id,
			workflowName: this.name,
			settings: this._settings,
			pinData: this._pinData,
			nameMapping: effectiveNameMapping,
			addNodeWithSubnodes: (node: NodeInstance<string, string, unknown>) => {
				const actualKey = this.addNodeWithSubnodes(nodes, node);
				// Auto-track renames when node is stored under a different key
				if (actualKey && actualKey !== node.name) {
					effectiveNameMapping.set(node.id, actualKey);
				}
				return actualKey;
			},
			addBranchToGraph: (branch: unknown) => {
				return this.addBranchToGraph(
					nodes,
					branch as NodeInstance<string, string, unknown>,
					effectiveNameMapping,
				);
			},
			trackRename: (nodeId: string, actualKey: string) => {
				effectiveNameMapping.set(nodeId, actualKey);
			},
		};
	}

	/**
	 * Collect pinData from a node and merge it with existing pinData
	 */
	private collectPinData(
		node: NodeInstance<string, string, unknown>,
	): Record<string, IDataObject[]> | undefined {
		const nodePinData = node.config?.pinData;
		if (!nodePinData || nodePinData.length === 0) {
			return this._pinData;
		}

		// Merge with existing pinData
		return {
			...this._pinData,
			[node.name]: nodePinData,
		};
	}

	/**
	 * Collect pinData from all nodes in a chain
	 */
	private collectPinDataFromChain(chain: NodeChain): Record<string, IDataObject[]> | undefined {
		let pinData = this._pinData;
		const registry = this._registry ?? pluginRegistry;

		for (const chainNode of chain.allNodes) {
			// Try plugin dispatch for composites
			const handler = registry.findCompositeHandler(chainNode);
			if (handler?.collectPinData) {
				handler.collectPinData(chainNode, (node) => {
					pinData = this.collectPinDataFromNode(node, pinData);
				});
			} else if (chainNode?.config?.pinData) {
				// Regular node with pinData
				pinData = this.collectPinDataFromNode(chainNode, pinData);
			}
		}
		return pinData;
	}

	/**
	 * Helper to collect pinData from a single node and merge with existing pinData
	 */
	private collectPinDataFromNode(
		node: NodeInstance<string, string, unknown>,
		existingPinData: Record<string, IDataObject[]> | undefined,
	): Record<string, IDataObject[]> | undefined {
		const nodePinData = node.config?.pinData;
		if (nodePinData && nodePinData.length > 0) {
			return {
				...existingPinData,
				[node.name]: nodePinData,
			};
		}
		return existingPinData;
	}

	add(node: unknown): WorkflowBuilder {
		const newNodes = new Map(this._nodes);

		// Handle plain array (fan-out)
		// This adds all targets without creating a primary connection
		if (Array.isArray(node)) {
			for (const target of node) {
				if (isInputTarget(target)) {
					// InputTarget - add the target node
					const inputTargetNode = target.node as NodeInstance<string, string, unknown>;
					if (!newNodes.has(inputTargetNode.name)) {
						this.addNodeWithSubnodes(newNodes, inputTargetNode);
					}
				} else if (isNodeChain(target)) {
					// Chain - add all nodes from the chain
					for (const chainNode of target.allNodes) {
						if (!newNodes.has(chainNode.name)) {
							this.addNodeWithSubnodes(newNodes, chainNode);
						}
					}
					this.addConnectionTargetNodes(newNodes, target);
				} else {
					// Regular node
					const targetNode = target as NodeInstance<string, string, unknown>;
					if (!newNodes.has(targetNode.name)) {
						this.addNodeWithSubnodes(newNodes, targetNode);
					}
				}
			}
			return this.clone({
				nodes: newNodes,
				currentNode: this._currentNode,
				currentOutput: this._currentOutput,
				pinData: this._pinData,
			});
		}

		// Check for plugin composite handlers FIRST
		// This allows registered handlers to intercept composites before built-in handling
		// Always use global pluginRegistry as fallback (like we do for validators)
		const addRegistry = this._registry ?? pluginRegistry;
		const addHandler = addRegistry.findCompositeHandler(node);
		if (addHandler) {
			const ctx = this.createMutablePluginContext(newNodes);
			const headName = addHandler.addNodes(node, ctx);
			return this.clone({
				nodes: newNodes,
				currentNode: headName,
				currentOutput: 0,
				pinData: this._pinData,
			});
		}

		// Check if this is a NodeChain
		if (isNodeChain(node)) {
			// Track node ID -> actual map key for renamed nodes
			const nameMapping = new Map<string, string>();

			// Add all nodes from the chain, handling composites that may have been chained
			for (const chainNode of node.allNodes) {
				// Try plugin dispatch for composites - nameMapping is propagated through context
				const pluginResult = this.tryPluginDispatch(newNodes, chainNode, nameMapping);
				if (pluginResult === undefined) {
					// Not a composite - add as regular node
					const actualKey = this.addNodeWithSubnodes(newNodes, chainNode);
					// Track the actual key if it was renamed
					if (actualKey && actualKey !== chainNode.name) {
						nameMapping.set(chainNode.id, actualKey);
					}
				}
			}
			// Also add nodes from connections that aren't in allNodes (e.g., onError handlers)
			this.addConnectionTargetNodes(newNodes, node, nameMapping);
			// Collect pinData from all nodes in the chain
			const chainPinData = this.collectPinDataFromChain(node);
			// Set currentNode to the tail (last node in the chain)
			// Use nameMapping to get the actual key if the tail was renamed
			const tailKey = nameMapping.get(node.tail.id) ?? node.tail.name;
			return this.clone({
				nodes: newNodes,
				currentNode: tailKey,
				currentOutput: 0,
				pinData: chainPinData,
			});
		}

		// At this point, plugin dispatch has handled IfElseBuilder/SwitchCaseBuilder, and we've
		// handled NodeChain. The remaining type is NodeInstance or TriggerInstance.
		// Cast to NodeInstance to satisfy TypeScript (type narrowing).
		const regularNode = node as NodeInstance<string, string, unknown>;

		// Regular node or trigger
		this.addNodeWithSubnodes(newNodes, regularNode);

		// Also add connection target nodes (e.g., onError handlers)
		// This is important when re-adding a node that already exists but has new connections
		this.addSingleNodeConnectionTargets(newNodes, regularNode);

		// Collect pinData from the node if present
		const newPinData = this.collectPinData(regularNode);

		return this.clone({
			nodes: newNodes,
			currentNode: regularNode.name,
			currentOutput: 0,
			pinData: newPinData,
		});
	}

	then(nodeOrComposite: unknown): WorkflowBuilder {
		// Handle array of nodes (fan-out pattern)
		if (Array.isArray(nodeOrComposite)) {
			return this.handleFanOut(nodeOrComposite);
		}

		// Handle NodeChain (e.g., node().then().then())
		// This must come before composite checks since chains have composite-like properties
		if (isNodeChain(nodeOrComposite)) {
			return this.handleNodeChain(nodeOrComposite);
		}

		// Check for plugin composite handlers
		// This allows registered handlers to intercept composites before built-in handling
		// Always use global pluginRegistry as fallback (like we do for validators)
		const thenRegistry = this._registry ?? pluginRegistry;
		const thenHandler = thenRegistry.findCompositeHandler(nodeOrComposite);
		if (thenHandler) {
			const newNodes = new Map(this._nodes);
			const ctx = this.createMutablePluginContext(newNodes);
			const headName = thenHandler.addNodes(nodeOrComposite, ctx);

			// Connect current node to head of composite
			if (this._currentNode) {
				const currentGraphNode = newNodes.get(this._currentNode);
				if (currentGraphNode) {
					const mainConns = currentGraphNode.connections.get('main') || new Map();
					const outputConns = mainConns.get(this._currentOutput) || [];
					outputConns.push({ node: headName, type: 'main', index: 0 });
					mainConns.set(this._currentOutput, outputConns);
					currentGraphNode.connections.set('main', mainConns);
				}
			}

			return this.clone({
				nodes: newNodes,
				currentNode: headName,
				currentOutput: 0,
				pinData: this._pinData,
			});
		}

		// At this point, plugin dispatch handled all composite types (IfElse, SwitchCase, Merge, SplitInBatches).
		// Remaining type is a regular NodeInstance.
		const node = nodeOrComposite as NodeInstance<string, string, unknown>;
		const newNodes = new Map(this._nodes);

		// Check if node already exists in the workflow (cycle connection)
		const existingNode = newNodes.has(node.name);

		if (existingNode) {
			// Node already exists - just add the connection, don't re-add the node
			if (this._currentNode) {
				const currentGraphNode = newNodes.get(this._currentNode);
				if (currentGraphNode) {
					const mainConns = currentGraphNode.connections.get('main') || new Map();
					const outputConnections = mainConns.get(this._currentOutput) || [];
					// Check for duplicate connections
					const alreadyConnected = outputConnections.some(
						(c: { node: string }) => c.node === node.name,
					);
					if (!alreadyConnected) {
						mainConns.set(this._currentOutput, [
							...outputConnections,
							{ node: node.name, type: 'main', index: 0 },
						]);
						currentGraphNode.connections.set('main', mainConns);
					}
				}
			}

			return this.clone({
				nodes: newNodes,
				currentNode: node.name,
				currentOutput: 0,
			});
		}

		// Add the new node and its subnodes
		this.addNodeWithSubnodes(newNodes, node);

		// Add connection target nodes (e.g., onError handlers)
		this.addSingleNodeConnectionTargets(newNodes, node);

		// Connect from current node if exists
		if (this._currentNode) {
			const currentGraphNode = newNodes.get(this._currentNode);
			if (currentGraphNode) {
				const mainConns = currentGraphNode.connections.get('main') || new Map();
				const outputConnections = mainConns.get(this._currentOutput) || [];
				mainConns.set(this._currentOutput, [
					...outputConnections,
					{ node: node.name, type: 'main', index: 0 },
				]);
				currentGraphNode.connections.set('main', mainConns);
			}
		}

		// Collect pinData from the node if present
		const newPinData = this.collectPinData(node);

		return this.clone({
			nodes: newNodes,
			currentNode: node.name,
			currentOutput: 0,
			pinData: newPinData,
		});
	}

	settings(settings: WorkflowSettings): WorkflowBuilder {
		return this.clone({
			settings: { ...this._settings, ...settings },
		});
	}

	connect(
		source: NodeInstance<string, string, unknown>,
		sourceOutput: number,
		target: NodeInstance<string, string, unknown>,
		targetInput: number,
	): WorkflowBuilder {
		const newNodes = new Map(this._nodes);

		// Ensure both nodes exist in the graph
		if (!newNodes.has(source.name)) {
			this.addNodeWithSubnodes(newNodes, source);
		}
		if (!newNodes.has(target.name)) {
			this.addNodeWithSubnodes(newNodes, target);
		}

		// Add the explicit connection from source to target
		const sourceNode = newNodes.get(source.name);
		if (sourceNode) {
			const mainConns = sourceNode.connections.get('main') || new Map<number, ConnectionTarget[]>();
			const outputConns = mainConns.get(sourceOutput) || [];

			// Check if connection already exists
			const alreadyExists = outputConns.some(
				(c: ConnectionTarget) => c.node === target.name && c.index === targetInput,
			);

			if (!alreadyExists) {
				outputConns.push({ node: target.name, type: 'main', index: targetInput });
				mainConns.set(sourceOutput, outputConns);
				sourceNode.connections.set('main', mainConns);
			}
		}

		return this.clone({
			nodes: newNodes,
			currentNode: this._currentNode,
			currentOutput: this._currentOutput,
		});
	}

	getNode(name: string): NodeInstance<string, string, unknown> | undefined {
		// First try direct lookup (for backward compatibility and nodes added via add/then)
		const directLookup = this._nodes.get(name);
		if (directLookup) {
			return directLookup.instance;
		}
		// Otherwise search by instance.name (for nodes loaded via fromJSON)
		for (const graphNode of this._nodes.values()) {
			if (graphNode.instance.name === name) {
				return graphNode.instance;
			}
		}
		return undefined;
	}

	toJSON(): WorkflowJSON {
		// Merge connections declared on node instances via .then() into the graph
		this.mergeInstanceConnections();

		// Create serializer context and delegate to jsonSerializer
		const ctx: SerializerContext = {
			nodes: this._nodes,
			workflowId: this.id,
			workflowName: this.name,
			settings: this._settings,
			pinData: this._pinData,
			meta: this._meta,
			resolveTargetNodeName: (target: unknown) => this.resolveTargetNodeName(target),
		};

		return jsonSerializer.serialize(ctx);
	}

	/**
	 * Merge connections declared on node instances via .then() into the graph connections.
	 * This prepares the graph for serialization by ensuring all connections are stored
	 * in graphNode.connections.
	 */
	private mergeInstanceConnections(): void {
		for (const graphNode of this._nodes.values()) {
			// Only process if the node instance has getConnections() (nodes from builder, not fromJSON)
			if (typeof graphNode.instance.getConnections === 'function') {
				const nodeConns = graphNode.instance.getConnections();
				for (const { target, outputIndex, targetInputIndex } of nodeConns) {
					// Resolve target node name - handles both NodeInstance and composites
					const targetName = this.resolveTargetNodeName(target);
					if (!targetName) continue;

					const mainConns = graphNode.connections.get('main') || new Map();
					const outputConns = mainConns.get(outputIndex) || [];
					// Avoid duplicates - check both target node AND input index
					const targetIndex = targetInputIndex ?? 0;
					const alreadyExists = outputConns.some(
						(c: ConnectionTarget) => c.node === targetName && c.index === targetIndex,
					);
					if (!alreadyExists) {
						outputConns.push({ node: targetName, type: 'main', index: targetIndex });
						mainConns.set(outputIndex, outputConns);
						graphNode.connections.set('main', mainConns);
					}
				}
			}
		}
	}

	/**
	 * Regenerate all node IDs using deterministic hashing based on workflow ID, node type, and node name.
	 * This ensures that the same workflow structure always produces the same node IDs,
	 * which is critical for the AI workflow builder where code may be re-parsed multiple times.
	 *
	 * Node IDs are generated using SHA-256 hash of `${workflowId}:${nodeType}:${nodeName}`,
	 * formatted as a valid UUID v4 structure.
	 */
	regenerateNodeIds(): void {
		const newNodes = new Map<string, GraphNode>();

		for (const [mapKey, graphNode] of this._nodes) {
			const instance = graphNode.instance;
			const newId = generateDeterministicNodeId(this.id, instance.type, instance.name);

			// Clone the instance with the new deterministic ID
			const newInstance = cloneNodeWithId(instance, newId);

			newNodes.set(mapKey, {
				instance: newInstance,
				connections: graphNode.connections,
			});
		}

		// Replace the nodes map
		this._nodes = newNodes;
	}

	validate(
		options: import('./validation/index').ValidationOptions = {},
	): import('./validation/index').ValidationResult {
		const { ValidationError, ValidationWarning } = require('./validation/index');
		const errors: import('./validation/index').ValidationError[] = [];
		const warnings: import('./validation/index').ValidationWarning[] = [];

		// Run plugin-based validators (use provided registry or global)
		const registry = this._registry ?? pluginRegistry;
		const pluginCtx: PluginContext = {
			nodes: this._nodes,
			workflowId: this.id,
			workflowName: this.name,
			settings: this._settings,
			pinData: this._pinData,
			validationOptions: {
				allowDisconnectedNodes: options.allowDisconnectedNodes,
				allowNoTrigger: options.allowNoTrigger,
				nodeTypesProvider: options.nodeTypesProvider,
			},
		};

		// Run validators for each node
		for (const [_mapKey, graphNode] of this._nodes) {
			const nodeType = graphNode.instance.type;
			const validators = registry.getValidatorsForNodeType(nodeType);

			for (const validator of validators) {
				const issues = validator.validateNode(graphNode.instance, graphNode, pluginCtx);
				this.collectValidationIssues(issues, errors, warnings, ValidationError, ValidationWarning);
			}
		}

		// Run workflow-level validators
		for (const validator of registry.getValidators()) {
			if (validator.validateWorkflow) {
				const issues = validator.validateWorkflow(pluginCtx);
				this.collectValidationIssues(issues, errors, warnings, ValidationError, ValidationWarning);
			}
		}

		return {
			valid: errors.length === 0,
			errors,
			warnings,
		};
	}

	/**
	 * Collect validation issues from plugins and add them to errors/warnings arrays
	 */
	private collectValidationIssues(
		issues: ValidationIssue[],
		errors: import('./validation/index').ValidationError[],
		warnings: import('./validation/index').ValidationWarning[],
		ValidationErrorClass: typeof import('./validation/index').ValidationError,
		ValidationWarningClass: typeof import('./validation/index').ValidationWarning,
	): void {
		for (const issue of issues) {
			// Cast code to ValidationErrorCode - plugins can use custom codes
			// that extend the built-in set
			const code = issue.code as import('./validation/index').ValidationErrorCode;
			if (issue.severity === 'error') {
				errors.push(new ValidationErrorClass(code, issue.message, issue.nodeName));
			} else {
				warnings.push(
					new ValidationWarningClass(
						code,
						issue.message,
						issue.nodeName,
						issue.parameterPath,
						issue.originalName,
					),
				);
			}
		}
	}

	toString(): string {
		return JSON.stringify(this.toJSON(), null, 2);
	}

	toFormat<T>(format: string): T {
		const registry = this._registry;
		if (!registry) {
			throw new Error(
				`No serializer registered for format '${format}'. Provide a registry with serializers when creating the workflow.`,
			);
		}
		const serializer = registry.getSerializer(format);
		if (!serializer) {
			throw new Error(`No serializer registered for format '${format}'`);
		}

		const ctx: SerializerContext = {
			nodes: this._nodes,
			workflowId: this.id,
			workflowName: this.name,
			settings: this._settings,
			pinData: this._pinData,
			meta: this._meta,
			resolveTargetNodeName: (target: unknown) => this.resolveTargetNodeName(target),
		};

		return serializer.serialize(ctx) as T;
	}

	generatePinData(options?: GeneratePinDataOptions): WorkflowBuilder {
		const { beforeWorkflow } = options ?? {};

		// Build set of existing node names from beforeWorkflow for quick lookup
		const existingNodeNames = beforeWorkflow
			? new Set(beforeWorkflow.nodes.map((n) => n.name))
			: undefined;

		for (const graphNode of this._nodes.values()) {
			const node = graphNode.instance;
			const nodeName = node.name;

			// Skip if node exists in beforeWorkflow (only process NEW nodes)
			if (existingNodeNames?.has(nodeName)) {
				continue;
			}

			// Skip if node already has pin data in current workflow
			if (this._pinData?.[nodeName]) {
				continue;
			}

			// Only generate for nodes that meet pin data criteria
			if (!shouldGeneratePinData(node)) {
				continue;
			}

			// Generate pin data from output declaration
			const output = node.config?.output;
			if (output && output.length > 0) {
				this._pinData = this._pinData ?? {};
				this._pinData[nodeName] = output;
			}
		}

		return this;
	}

	/**
	 * Find the map key for a node instance by its ID.
	 * This handles renamed duplicate nodes where the map key differs from instance.name.
	 */
	private findMapKeyForNodeId(nodeId: string): string | undefined {
		for (const [key, graphNode] of this._nodes) {
			if (graphNode.instance.id === nodeId) {
				return key;
			}
		}
		return undefined;
	}

	/**
	 * Resolve the target node name from a connection target.
	 * Handles NodeInstance, NodeChain, and composites (via registry's resolveCompositeHeadName).
	 * Returns the map key (which may differ from instance.name for renamed duplicates).
	 * @param nameMapping - Optional map from node ID to actual map key (used when nodes are renamed during addBranchToGraph)
	 */
	private resolveTargetNodeName(
		target: unknown,
		nameMapping?: Map<string, string>,
	): string | undefined {
		if (target === null || typeof target !== 'object') return undefined;

		// Helper to get the actual node name, accounting for auto-renamed nodes
		const getNodeName = (nodeInstance: NodeInstance<string, string, unknown>): string => {
			// First check the passed-in nameMapping (used during addBranchToGraph)
			const mappedKey = nameMapping?.get(nodeInstance.id);
			if (mappedKey) return mappedKey;

			// Fall back to searching in this._nodes
			const mapKey = this.findMapKeyForNodeId(nodeInstance.id);
			if (!mapKey) return nodeInstance.name;

			// Check if this is an auto-renamed node (e.g., "Process 1" from "Process")
			// Auto-renamed nodes have pattern: mapKey = instance.name + " " + number
			const isAutoRenamed =
				mapKey !== nodeInstance.name &&
				mapKey.startsWith(nodeInstance.name + ' ') &&
				/^\d+$/.test(mapKey.slice(nodeInstance.name.length + 1));

			return isAutoRenamed ? mapKey : nodeInstance.name;
		};

		// Check for NodeChain - return the head's name (where connections enter the chain)
		if (isNodeChain(target)) {
			return getNodeName(target.head);
		}

		// Try registry resolution for composites (IfElse, SwitchCase, SplitInBatches)
		const registry = this._registry ?? pluginRegistry;
		const compositeHeadName = registry.resolveCompositeHeadName(target, nameMapping);
		if (compositeHeadName !== undefined) {
			return compositeHeadName;
		}

		// Check for InputTarget - return the referenced node's name
		if (isInputTarget(target)) {
			return getNodeName(target.node as NodeInstance<string, string, unknown>);
		}

		// Regular NodeInstance
		return getNodeName(target as NodeInstance<string, string, unknown>);
	}

	/**
	 * Add target nodes from a chain's connections that aren't already in the nodes map.
	 * This handles nodes added via .onError() which aren't included in the chain's allNodes.
	 * @param nameMapping - Optional map from node ID to actual map key (used when nodes are renamed)
	 */
	private addConnectionTargetNodes(
		nodes: Map<string, GraphNode>,
		chain: NodeChain,
		nameMapping?: Map<string, string>,
	): void {
		const registry = this._registry ?? pluginRegistry;
		const connections = chain.getConnections();
		for (const { target } of connections) {
			// Skip if target is a composite type (already handled by plugin dispatch elsewhere)
			if (registry.isCompositeType(target)) continue;

			// Handle NodeChains - use addBranchToGraph to add all nodes with their connections
			if (isNodeChain(target)) {
				this.addBranchToGraph(nodes, target as NodeChain, nameMapping);
				continue;
			}

			// Handle InputTarget - add the referenced node
			if (isInputTarget(target)) {
				const inputTargetNode = target.node as NodeInstance<string, string, unknown>;
				if (!nodes.has(inputTargetNode.name)) {
					const actualKey = this.addNodeWithSubnodes(nodes, inputTargetNode);
					if (actualKey && nameMapping && actualKey !== inputTargetNode.name) {
						nameMapping.set(inputTargetNode.id, actualKey);
					}
				}
				continue;
			}

			// Add the target node if not already in the map
			const targetNode = target as NodeInstance<string, string, unknown>;
			if (!nodes.has(targetNode.name)) {
				const actualKey = this.addNodeWithSubnodes(nodes, targetNode);
				if (actualKey && nameMapping && actualKey !== targetNode.name) {
					nameMapping.set(targetNode.id, actualKey);
				}
			}
		}
	}

	/**
	 * Add target nodes from a single node's connections (e.g., onError handlers).
	 * This handles connection targets that aren't part of a chain.
	 */
	private addSingleNodeConnectionTargets(
		nodes: Map<string, GraphNode>,
		nodeInstance: NodeInstance<string, string, unknown>,
	): void {
		// Check if node has getConnections method (some composites don't)
		if (typeof nodeInstance.getConnections !== 'function') return;

		const registry = this._registry ?? pluginRegistry;
		const connections = nodeInstance.getConnections();
		for (const { target } of connections) {
			// Skip if target is a composite type (already handled by plugin dispatch elsewhere)
			if (registry.isCompositeType(target)) continue;

			// Handle NodeChains - use addBranchToGraph to add all nodes with their connections
			if (isNodeChain(target)) {
				this.addBranchToGraph(nodes, target as NodeChain);
				continue;
			}

			// Handle InputTarget - add the referenced node
			if (isInputTarget(target)) {
				const inputTargetNode = target.node as NodeInstance<string, string, unknown>;
				if (!nodes.has(inputTargetNode.name)) {
					this.addNodeWithSubnodes(nodes, inputTargetNode);
				}
				continue;
			}

			// Add the target node if not already in the map
			const targetNode = target as NodeInstance<string, string, unknown>;
			if (!nodes.has(targetNode.name)) {
				this.addNodeWithSubnodes(nodes, targetNode);
			}
		}
	}

	/**
	 * Try to dispatch a composite to a plugin handler.
	 * Returns the head node name if a handler processed it, undefined otherwise.
	 *
	 * This is used to replace inline composite handling methods with plugin-based dispatch.
	 * The method checks for duplicate processing using the main node name and delegates
	 * to the appropriate plugin handler if one is registered.
	 *
	 * @param nodes The mutable nodes map
	 * @param target The target to dispatch (composite, builder, or node)
	 * @param nameMapping Optional map to track node ID → actual map key for renamed nodes
	 */
	private tryPluginDispatch(
		nodes: Map<string, GraphNode>,
		target: unknown,
		nameMapping?: Map<string, string>,
	): string | undefined {
		// NOTE: We intentionally don't skip if the main node already exists.
		// Handlers like ifElseHandler are designed to MERGE connections when the node exists.
		// This is important for patterns like:
		//   .add(is_Approved.then(merge1.input(1)))  // Adds IF node first
		//   .add(merge_node.then(set_Default_True_2.then(is_Approved.onTrue(x_Post.then(x_Result)))))
		// The second line needs to add the onTrue() branch even though the IF node already exists.

		// Try plugin dispatch
		const registry = this._registry ?? pluginRegistry;
		const handler = registry.findCompositeHandler(target);
		if (handler) {
			const ctx = this.createMutablePluginContext(nodes, nameMapping);
			return handler.addNodes(target, ctx);
		}

		return undefined;
	}

	/**
	 * Generate a unique node name if the name already exists
	 */
	private generateUniqueName(nodes: Map<string, GraphNode>, baseName: string): string {
		if (!nodes.has(baseName)) {
			return baseName;
		}

		// Find the next available number suffix
		let counter = 1;
		let newName = `${baseName} ${counter}`;
		while (nodes.has(newName)) {
			counter++;
			newName = `${baseName} ${counter}`;
		}
		return newName;
	}

	/**
	 * Add a node and its subnodes to the nodes map, creating AI connections.
	 * Returns the actual map key used (may differ from nodeInstance.name if renamed),
	 * or undefined if the node was skipped (invalid or duplicate reference).
	 */
	private addNodeWithSubnodes(
		nodes: Map<string, GraphNode>,
		nodeInstance: NodeInstance<string, string, unknown>,
	): string | undefined {
		// Guard against invalid node instances (e.g., empty objects from chain.allNodes)
		if (!nodeInstance || typeof nodeInstance !== 'object') {
			return undefined;
		}
		if (!nodeInstance.type || !nodeInstance.name) {
			// Not a valid node instance - skip silently
			return undefined;
		}

		// Check if this exact instance is already in the map under any key.
		// This is necessary because a node may have been renamed (e.g., "Format Response" -> "Format Response 1")
		// but the same instance reference appears multiple times in chain targets.
		for (const [key, graphNode] of nodes) {
			if (graphNode.instance === nodeInstance) {
				return key; // Already added, return the existing key
			}
		}

		// Check if a node with the same name already exists
		const existingNode = nodes.get(nodeInstance.name);
		if (existingNode) {
			// If it's the same node instance (by reference), skip - it's a duplicate reference
			if (existingNode.instance === nodeInstance) {
				return undefined;
			}
			// Different node instance with same name - generate unique name and add it
			// This handles the case where user creates multiple nodes with the same name
			const uniqueName = this.generateUniqueName(nodes, nodeInstance.name);
			const connectionsMap = new Map<string, Map<number, ConnectionTarget[]>>();
			connectionsMap.set('main', new Map());
			nodes.set(uniqueName, {
				instance: nodeInstance,
				connections: connectionsMap,
			});
			return uniqueName;
		}

		// Add the main node
		const connectionsMap = new Map<string, Map<number, ConnectionTarget[]>>();
		connectionsMap.set('main', new Map());
		nodes.set(nodeInstance.name, {
			instance: nodeInstance,
			connections: connectionsMap,
		});

		// Process subnodes if present
		const subnodes = nodeInstance.config?.subnodes as SubnodeConfig | undefined;
		if (!subnodes) return nodeInstance.name;

		// Helper to add a subnode with its AI connection (recursively handles nested subnodes)
		const addSubnode = (subnode: NodeInstance<string, string, unknown>, connectionType: string) => {
			const existingSubnode = nodes.get(subnode.name);

			if (existingSubnode) {
				// Subnode already exists - merge the new AI connection
				let existingAiConns = existingSubnode.connections.get(connectionType);
				if (!existingAiConns) {
					existingAiConns = new Map();
					existingSubnode.connections.set(connectionType, existingAiConns);
				}
				const existingOutputConns = existingAiConns.get(0) ?? [];
				existingAiConns.set(0, [
					...existingOutputConns,
					{ node: nodeInstance.name, type: connectionType, index: 0 },
				]);
				return; // Don't process nested subnodes again - already done
			}

			// New subnode - add it with its connection
			const subnodeConns = new Map<string, Map<number, ConnectionTarget[]>>();
			subnodeConns.set('main', new Map());
			// Create AI connection from subnode to parent node
			const aiConnMap = new Map<number, ConnectionTarget[]>();
			aiConnMap.set(0, [{ node: nodeInstance.name, type: connectionType, index: 0 }]);
			subnodeConns.set(connectionType, aiConnMap);
			nodes.set(subnode.name, {
				instance: subnode,
				connections: subnodeConns,
			});

			// Recursively process any nested subnodes this subnode might have (only for new subnodes)
			const nestedSubnodes = subnode.config?.subnodes as SubnodeConfig | undefined;
			if (nestedSubnodes) {
				this.processSubnodesRecursively(nodes, subnode, nestedSubnodes);
			}
		};

		// Helper to add single or array of subnodes
		const addSubnodeOrArray = (
			subnodeOrArray:
				| NodeInstance<string, string, unknown>
				| NodeInstance<string, string, unknown>[]
				| undefined,
			connectionType: string,
		) => {
			if (!subnodeOrArray) return;
			if (Array.isArray(subnodeOrArray)) {
				for (const subnode of subnodeOrArray) {
					addSubnode(subnode, connectionType);
				}
			} else {
				addSubnode(subnodeOrArray, connectionType);
			}
		};

		// Add model subnode(s) - can be array for modelSelector
		addSubnodeOrArray(subnodes.model, 'ai_languageModel');

		// Add memory subnode
		if (subnodes.memory) {
			addSubnode(subnodes.memory, 'ai_memory');
		}

		// Add tool subnodes
		if (subnodes.tools) {
			for (const tool of subnodes.tools) {
				addSubnode(tool, 'ai_tool');
			}
		}

		// Add output parser subnode
		if (subnodes.outputParser) {
			addSubnode(subnodes.outputParser, 'ai_outputParser');
		}

		// Add embedding subnode(s) - accept both 'embedding' and 'embeddings' keys
		addSubnodeOrArray(subnodes.embedding ?? subnodes.embeddings, 'ai_embedding');

		// Add vector store subnode
		if (subnodes.vectorStore) {
			addSubnode(subnodes.vectorStore, 'ai_vectorStore');
		}

		// Add retriever subnode
		if (subnodes.retriever) {
			addSubnode(subnodes.retriever, 'ai_retriever');
		}

		// Add document loader subnode(s)
		addSubnodeOrArray(subnodes.documentLoader, 'ai_document');

		// Add text splitter subnode
		if (subnodes.textSplitter) {
			addSubnode(subnodes.textSplitter, 'ai_textSplitter');
		}

		// Add reranker subnode
		if (subnodes.reranker) {
			addSubnode(subnodes.reranker, 'ai_reranker');
		}

		return nodeInstance.name;
	}

	/**
	 * Recursively process nested subnodes for a parent node
	 */
	private processSubnodesRecursively(
		nodes: Map<string, GraphNode>,
		parentNode: NodeInstance<string, string, unknown>,
		subnodes: SubnodeConfig,
	): void {
		// Helper to add a nested subnode with its AI connection
		const addNestedSubnode = (
			subnode: NodeInstance<string, string, unknown>,
			connectionType: string,
		) => {
			const existingSubnode = nodes.get(subnode.name);

			if (existingSubnode) {
				// Subnode already exists - merge the new AI connection
				let existingAiConns = existingSubnode.connections.get(connectionType);
				if (!existingAiConns) {
					existingAiConns = new Map();
					existingSubnode.connections.set(connectionType, existingAiConns);
				}
				const existingOutputConns = existingAiConns.get(0) ?? [];
				existingAiConns.set(0, [
					...existingOutputConns,
					{ node: parentNode.name, type: connectionType, index: 0 },
				]);
				return; // Don't process nested subnodes again - already done
			}

			// New subnode - add it with its connection
			const subnodeConns = new Map<string, Map<number, ConnectionTarget[]>>();
			subnodeConns.set('main', new Map());
			// Create AI connection from subnode to parent
			const aiConnMap = new Map<number, ConnectionTarget[]>();
			aiConnMap.set(0, [{ node: parentNode.name, type: connectionType, index: 0 }]);
			subnodeConns.set(connectionType, aiConnMap);
			nodes.set(subnode.name, {
				instance: subnode,
				connections: subnodeConns,
			});

			// Recursively process any nested subnodes (only for new subnodes)
			const nestedSubnodes = subnode.config?.subnodes as SubnodeConfig | undefined;
			if (nestedSubnodes) {
				this.processSubnodesRecursively(nodes, subnode, nestedSubnodes);
			}
		};

		// Helper to add single or array of nested subnodes
		const addNestedSubnodeOrArray = (
			subnodeOrArray:
				| NodeInstance<string, string, unknown>
				| NodeInstance<string, string, unknown>[]
				| undefined,
			connectionType: string,
		) => {
			if (!subnodeOrArray) return;
			if (Array.isArray(subnodeOrArray)) {
				for (const subnode of subnodeOrArray) {
					addNestedSubnode(subnode, connectionType);
				}
			} else {
				addNestedSubnode(subnodeOrArray, connectionType);
			}
		};

		// Process all subnode types
		addNestedSubnodeOrArray(subnodes.model, 'ai_languageModel');
		if (subnodes.memory) addNestedSubnode(subnodes.memory, 'ai_memory');
		if (subnodes.tools) {
			for (const tool of subnodes.tools) {
				addNestedSubnode(tool, 'ai_tool');
			}
		}
		if (subnodes.outputParser) addNestedSubnode(subnodes.outputParser, 'ai_outputParser');
		addNestedSubnodeOrArray(subnodes.embedding ?? subnodes.embeddings, 'ai_embedding');
		if (subnodes.vectorStore) addNestedSubnode(subnodes.vectorStore, 'ai_vectorStore');
		if (subnodes.retriever) addNestedSubnode(subnodes.retriever, 'ai_retriever');
		addNestedSubnodeOrArray(subnodes.documentLoader, 'ai_document');
		if (subnodes.textSplitter) addNestedSubnode(subnodes.textSplitter, 'ai_textSplitter');
		if (subnodes.reranker) addNestedSubnode(subnodes.reranker, 'ai_reranker');
	}

	/**
	 * Handle fan-out pattern - connects current node to multiple target nodes
	 * Supports NodeChain targets (e.g., workflow.then([x1, fb, linkedin.then(sheets)]))
	 *
	 * Each array element maps to a different output index (branching).
	 * Use null to skip an output index.
	 */
	private handleFanOut(nodes: unknown[]): WorkflowBuilder {
		if (nodes.length === 0) {
			return this;
		}

		const newNodes = new Map(this._nodes);
		const currentGraphNode = this._currentNode ? newNodes.get(this._currentNode) : undefined;

		// Add all target nodes and connect them to the current node
		nodes.forEach((node, index) => {
			// Skip null values (empty branches) but preserve the index for correct output mapping
			if (node === null) {
				return;
			}

			// Use addBranchToGraph to handle NodeChains properly
			// This returns the head node name for connection
			const headNodeName = this.addBranchToGraph(
				newNodes,
				node as NodeInstance<string, string, unknown>,
			);

			// Connect from current node to the head of this target
			// Array syntax always uses incrementing output indices (branching behavior)
			if (this._currentNode && currentGraphNode) {
				const mainConns = currentGraphNode.connections.get('main') || new Map();
				const outputConnections = mainConns.get(index) || [];
				mainConns.set(index, [
					...outputConnections,
					{ node: headNodeName, type: 'main', index: 0 },
				]);
				currentGraphNode.connections.set('main', mainConns);
			}
		});

		// Set the last non-null node in the array as the current node (for continued chaining)
		// For NodeChains, use the tail node name (if tail is not null)
		const nonNullNodes = nodes.filter((n): n is NonNullable<unknown> => n !== null);
		const lastNode = nonNullNodes[nonNullNodes.length - 1];
		const lastNodeName = lastNode
			? isNodeChain(lastNode)
				? (lastNode.tail?.name ?? this._currentNode)
				: (lastNode as NodeInstance<string, string, unknown>).name
			: this._currentNode;

		return this.clone({
			nodes: newNodes,
			currentNode: lastNodeName,
			currentOutput: 0,
		});
	}

	/**
	 * Handle a NodeChain passed to workflow.then()
	 * This is used when chained node calls are passed directly, e.g., workflow.then(node().then().then())
	 */
	private handleNodeChain(chain: NodeChain): WorkflowBuilder {
		const newNodes = new Map(this._nodes);

		// Add the head node and connect from current workflow position
		const headNodeName = this.addBranchToGraph(newNodes, chain);

		// Connect from current workflow node to the head of the chain
		if (this._currentNode) {
			const currentGraphNode = newNodes.get(this._currentNode);
			if (currentGraphNode) {
				const mainConns = currentGraphNode.connections.get('main') || new Map();
				const outputConnections = mainConns.get(this._currentOutput) || [];

				// Standard behavior: connect to chain head
				outputConnections.push({ node: headNodeName, type: 'main', index: 0 });

				mainConns.set(this._currentOutput, outputConnections);
				currentGraphNode.connections.set('main', mainConns);
			}
		}

		// Collect pinData from the chain
		const chainPinData = this.collectPinDataFromChain(chain);

		// Set current node to the tail of the chain
		const tailName = chain.tail?.name ?? headNodeName;

		return this.clone({
			nodes: newNodes,
			currentNode: tailName,
			currentOutput: 0,
			pinData: chainPinData,
		});
	}

	/**
	 * Add a branch to the graph, handling both single nodes and NodeChains.
	 * Returns the name of the first node in the branch (for connection from IF).
	 * @param nameMapping - Optional map from node ID to actual map key (used when nodes are renamed)
	 */
	private addBranchToGraph(
		nodes: Map<string, GraphNode>,
		branch: NodeInstance<string, string, unknown>,
		nameMapping?: Map<string, string>,
	): string {
		// Create nameMapping if not passed (tracks node ID -> actual map key for renamed nodes)
		const effectiveNameMapping = nameMapping ?? new Map<string, string>();
		const registry = this._registry ?? pluginRegistry;

		// Try plugin dispatch first - handles all composite types
		const pluginResult = this.tryPluginDispatch(nodes, branch, effectiveNameMapping);
		if (pluginResult !== undefined) {
			return pluginResult;
		}

		// Check if the branch is a NodeChain
		if (isNodeChain(branch)) {
			// Add all nodes from the chain, handling composites that may have been chained
			for (const chainNode of branch.allNodes) {
				// Skip null values (can occur when .then([null, node]) is used)
				if (chainNode === null) {
					continue;
				}

				// Skip invalid objects that aren't valid nodes or composites
				// An object is valid if it has a 'name' property (NodeInstance) or is a registered composite type
				if (
					typeof chainNode !== 'object' ||
					(!('name' in chainNode) && !registry.isCompositeType(chainNode))
				) {
					continue;
				}

				// Try plugin dispatch for composites
				const chainPluginResult = this.tryPluginDispatch(nodes, chainNode, effectiveNameMapping);
				if (chainPluginResult === undefined) {
					// Not a composite - add as regular node
					const actualKey = this.addNodeWithSubnodes(nodes, chainNode);
					// Track the actual key if it was renamed
					if (actualKey && actualKey !== chainNode.name) {
						effectiveNameMapping.set(chainNode.id, actualKey);
					}
				}
			}

			// Process connections declared on the chain (from .then() calls)
			const connections = branch.getConnections();
			for (const { target, outputIndex, targetInputIndex } of connections) {
				// Find the source node in the chain that declared this connection
				// by looking for the node whose .then() was called
				for (const chainNode of branch.allNodes) {
					// Skip null values (from array syntax like [null, node])
					if (chainNode === null) {
						continue;
					}

					// Get the actual node instance that might have connections
					// Nodes without getConnections (like SplitInBatchesBuilder) are skipped
					if (typeof chainNode.getConnections !== 'function') {
						continue;
					}
					const nodeToCheck = chainNode;
					const nodeName = chainNode.name;

					if (nodeToCheck && nodeName && typeof nodeToCheck.getConnections === 'function') {
						const nodeConns = nodeToCheck.getConnections();
						if (nodeConns.some((c) => c.target === target && c.outputIndex === outputIndex)) {
							// This chain node declared this connection
							// First, ensure target nodes are added to the graph (e.g., error handler chains)
							if (isNodeChain(target)) {
								const chainTarget = target as NodeChain;
								// Add each node in the chain that isn't already in the map
								// We can't just check the head because the chain may reuse an existing
								// node as head (e.g., set_content) while having new nodes after it
								for (const targetChainNode of chainTarget.allNodes) {
									if (targetChainNode === null) continue;

									// Try plugin dispatch for composites
									const targetPluginResult = this.tryPluginDispatch(
										nodes,
										targetChainNode,
										effectiveNameMapping,
									);
									if (targetPluginResult === undefined && !nodes.has(targetChainNode.name)) {
										// Not a composite and not already present - add as regular node
										this.addNodeWithSubnodes(nodes, targetChainNode);
									}
								}
							} else if (
								typeof (target as NodeInstance<string, string, unknown>).name === 'string' &&
								!nodes.has((target as NodeInstance<string, string, unknown>).name)
							) {
								this.addNodeWithSubnodes(nodes, target as NodeInstance<string, string, unknown>);
							}

							// Use the effectiveNameMapping to get the actual key if the node was renamed
							const mappedKey = nodeToCheck && effectiveNameMapping.get(nodeToCheck.id);
							const actualSourceKey = mappedKey ?? nodeName;
							const sourceGraphNode = nodes.get(actualSourceKey!);
							if (sourceGraphNode) {
								const targetName = this.resolveTargetNodeName(target, effectiveNameMapping);
								if (targetName) {
									const mainConns = sourceGraphNode.connections.get('main') || new Map();
									const outputConns = mainConns.get(outputIndex) || [];
									if (!outputConns.some((c: ConnectionTarget) => c.node === targetName)) {
										outputConns.push({
											node: targetName,
											type: 'main',
											index: targetInputIndex ?? 0,
										});
										mainConns.set(outputIndex, outputConns);
										sourceGraphNode.connections.set('main', mainConns);
									}
								}
							}
						}
					}
				}
			}

			// Return the head node name (first node in the chain)
			// Use effectiveNameMapping to get the actual key if the head was renamed
			const headKey = effectiveNameMapping.get(branch.head.id) ?? branch.head.name;
			return headKey;
		} else {
			// Single node - add it and return its name
			// Note: Composites are handled by tryPluginDispatch at the entry point
			const actualKey = this.addNodeWithSubnodes(nodes, branch);
			// If the node was renamed, track it and return the actual key
			if (actualKey && actualKey !== branch.name) {
				effectiveNameMapping.set(branch.id, actualKey);
			}
			return actualKey ?? branch.name;
		}
	}
}

/**
 * Helper to check if options is a WorkflowBuilderOptions object
 */
function isWorkflowBuilderOptions(
	options: WorkflowSettings | WorkflowBuilderOptions | undefined,
): options is WorkflowBuilderOptions {
	if (!options) return false;
	// WorkflowBuilderOptions has 'settings' or 'registry' as keys
	// WorkflowSettings has keys like 'timezone', 'executionOrder', etc.
	return 'settings' in options || 'registry' in options;
}

/**
 * Create a new workflow builder
 */
function createWorkflow(
	id: string,
	name: string,
	options?: WorkflowSettings | WorkflowBuilderOptions,
): WorkflowBuilder {
	if (isWorkflowBuilderOptions(options)) {
		return new WorkflowBuilderImpl(
			id,
			name,
			options.settings,
			undefined,
			undefined,
			undefined,
			undefined,
			options.registry,
		);
	}
	return new WorkflowBuilderImpl(id, name, options);
}

/**
 * Import workflow from n8n JSON format
 */
function fromJSON(json: WorkflowJSON): WorkflowBuilder {
	const nodes = new Map<string, GraphNode>();
	// Map from connection name (how nodes reference each other) to map key
	const nameToKey = new Map<string, string>();

	// Create node instances from JSON
	let unnamedCounter = 0;
	for (const n8nNode of json.nodes) {
		const version = `v${n8nNode.typeVersion}`;

		// Preserve original credentials exactly - don't transform
		// Some workflows have empty placeholder credentials like {}
		const credentials = n8nNode.credentials
			? (JSON.parse(JSON.stringify(n8nNode.credentials)) as Record<
					string,
					CredentialReference | NewCredentialValue
				>)
			: undefined;

		// Create a minimal node instance
		// For nodes without a name (like sticky notes), use the id as the internal name
		// but preserve the original name (or lack thereof) for export
		const nodeName = n8nNode.name ?? n8nNode.id;
		const instance: NodeInstance<string, string, unknown> = {
			type: n8nNode.type,
			version,
			id: n8nNode.id,
			name: nodeName,
			config: {
				name: nodeName, // Include name in config for consistency
				parameters: n8nNode.parameters as IDataObject,
				credentials,
				// Store original name to preserve it in toJSON (undefined for sticky notes without name)
				// Using spread to add internal property without polluting the type
				...({ _originalName: n8nNode.name } as Record<string, unknown>),
				position: n8nNode.position,
				disabled: n8nNode.disabled,
				notes: n8nNode.notes,
				notesInFlow: n8nNode.notesInFlow,
				executeOnce: n8nNode.executeOnce,
				retryOnFail: n8nNode.retryOnFail,
				alwaysOutputData: n8nNode.alwaysOutputData,
				onError: n8nNode.onError,
			},
			update: function (config) {
				return {
					...this,
					config: { ...this.config, ...config },
				};
			},
			then: function () {
				throw new Error(
					'Nodes from fromJSON() do not support then() - use workflow builder methods',
				);
			},
			to: function () {
				throw new Error('Nodes from fromJSON() do not support to() - use workflow builder methods');
			},
			input: function () {
				throw new Error(
					'Nodes from fromJSON() do not support input() - use workflow builder methods',
				);
			},
			output: function () {
				throw new Error(
					'Nodes from fromJSON() do not support output() - use workflow builder methods',
				);
			},
			onError: function () {
				throw new Error(
					'Nodes from fromJSON() do not support onError() - use workflow builder methods',
				);
			},
			getConnections: function () {
				return [];
			},
		};

		// Initialize connections map with all connection types
		const connectionsMap = new Map<string, Map<number, ConnectionTarget[]>>();

		// Use a unique key for the map (ID if available, otherwise generate one)
		// Connections reference nodes by name, so we also build a name->key mapping
		const mapKey = n8nNode.id || `__unnamed_${unnamedCounter++}`;
		// Always add to nameToKey since we now have a valid nodeName
		nameToKey.set(nodeName, mapKey);

		nodes.set(mapKey, {
			instance,
			connections: connectionsMap,
		});
	}

	// Rebuild connections - handle all connection types
	if (json.connections) {
		for (const [sourceName, nodeConns] of Object.entries(json.connections)) {
			// Find the node by its name using the nameToKey mapping
			const mapKey = nameToKey.get(sourceName);
			const graphNode = mapKey ? nodes.get(mapKey) : undefined;
			if (!graphNode) continue;

			// Iterate over all connection types (main, ai_tool, ai_memory, etc.)
			for (const [connType, outputs] of Object.entries(nodeConns)) {
				if (!outputs || !Array.isArray(outputs)) continue;

				const typeMap =
					graphNode.connections.get(connType) || new Map<number, ConnectionTarget[]>();

				// Store all outputs including empty ones to preserve array structure
				for (let outputIndex = 0; outputIndex < outputs.length; outputIndex++) {
					const targets = outputs[outputIndex];
					if (targets && targets.length > 0) {
						typeMap.set(
							outputIndex,
							targets.map((conn: { node: string; type: string; index: number }) => ({
								node: conn.node,
								type: conn.type,
								index: conn.index,
							})),
						);
					} else {
						// Store empty array to preserve output index
						typeMap.set(outputIndex, []);
					}
				}

				graphNode.connections.set(connType, typeMap);
			}
		}
	}

	// Find the last node in the chain for currentNode
	let lastNode: string | null = null;
	for (const name of nodes.keys()) {
		lastNode = name;
	}

	return new WorkflowBuilderImpl(
		json.id ?? '',
		json.name,
		json.settings,
		nodes,
		lastNode,
		json.pinData,
		json.meta,
	);
}

/**
 * Workflow builder factory function with static methods
 */
export const workflow: WorkflowBuilderStatic = Object.assign(createWorkflow, {
	fromJSON,
});
