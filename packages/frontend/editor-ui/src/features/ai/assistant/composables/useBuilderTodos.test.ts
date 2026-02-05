import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import {
	extractPlaceholderLabels,
	findPlaceholderDetails,
	formatPlaceholderPath,
	isPlaceholderValue,
	useBuilderTodos,
} from './useBuilderTodos';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import type { INodeUi } from '@/Interface';

vi.mock('@n8n/i18n', async (importActual) => ({
	...(await importActual()),
	useI18n: () => ({
		baseText: (key: string, options?: { interpolate?: Record<string, string> }) =>
			options?.interpolate ? `${key}: ${JSON.stringify(options.interpolate)}` : key,
	}),
}));

describe('useBuilderTodos', () => {
	describe('extractPlaceholderLabels', () => {
		it('returns empty array for non-string values', () => {
			expect(extractPlaceholderLabels(123)).toEqual([]);
			expect(extractPlaceholderLabels(true)).toEqual([]);
			expect(extractPlaceholderLabels(null)).toEqual([]);
			expect(extractPlaceholderLabels(undefined)).toEqual([]);
			expect(extractPlaceholderLabels({})).toEqual([]);
			expect(extractPlaceholderLabels([])).toEqual([]);
		});

		it('returns empty array for strings without placeholder format', () => {
			expect(extractPlaceholderLabels('regular string')).toEqual([]);
			expect(extractPlaceholderLabels('https://example.com')).toEqual([]);
			expect(extractPlaceholderLabels('')).toEqual([]);
		});

		it('returns empty array for partial placeholder format', () => {
			expect(extractPlaceholderLabels('<__PLACEHOLDER_VALUE__missing end')).toEqual([]);
			expect(extractPlaceholderLabels('PLACEHOLDER__test__>')).toEqual([]);
			expect(extractPlaceholderLabels('__PLACEHOLDER_VALUE__test__>')).toEqual([]);
		});

		it('returns empty array for empty label', () => {
			expect(extractPlaceholderLabels('<__PLACEHOLDER_VALUE____>')).toEqual([]);
		});

		it('returns empty array for whitespace-only label', () => {
			expect(extractPlaceholderLabels('<__PLACEHOLDER_VALUE__   __>')).toEqual([]);
		});

		it('extracts label from valid placeholder', () => {
			expect(extractPlaceholderLabels('<__PLACEHOLDER_VALUE__Enter URL__>')).toEqual(['Enter URL']);
			expect(extractPlaceholderLabels('<__PLACEHOLDER_VALUE__API Key__>')).toEqual(['API Key']);
		});

		it('trims whitespace from label', () => {
			expect(extractPlaceholderLabels('<__PLACEHOLDER_VALUE__  Enter URL  __>')).toEqual([
				'Enter URL',
			]);
		});

		it('extracts single embedded placeholder from code', () => {
			const code = "const apiKey = '<__PLACEHOLDER_VALUE__API_KEY__>';";
			expect(extractPlaceholderLabels(code)).toEqual(['API_KEY']);
		});

		it('extracts multiple embedded placeholders from code', () => {
			const code = `
				const apiKey = '<__PLACEHOLDER_VALUE__API_KEY__>';
				const endpoint = '<__PLACEHOLDER_VALUE__API_ENDPOINT__>';
			`;
			expect(extractPlaceholderLabels(code)).toEqual(['API_KEY', 'API_ENDPOINT']);
		});

		it('handles placeholders in complex code', () => {
			const code = `
				// This is a comment
				function getData() {
					const url = '<__PLACEHOLDER_VALUE__Base URL__>' + '/api/data';
					const headers = {
						'Authorization': 'Bearer <__PLACEHOLDER_VALUE__API Token__>'
					};
					return fetch(url, { headers });
				}
			`;
			expect(extractPlaceholderLabels(code)).toEqual(['Base URL', 'API Token']);
		});

		it('extracts label from alternative placeholder format with colon', () => {
			expect(extractPlaceholderLabels('<__PLACEHOLDER__: Add your custom code here__>')).toEqual([
				'Add your custom code here',
			]);
		});

		it('extracts labels from mixed placeholder formats', () => {
			const code = `
				const apiKey = '<__PLACEHOLDER_VALUE__API_KEY__>';
				const customCode = '<__PLACEHOLDER__: Add your code here__>';
			`;
			expect(extractPlaceholderLabels(code)).toEqual(['API_KEY', 'Add your code here']);
		});
	});

	describe('findPlaceholderDetails', () => {
		it('returns empty array for primitive non-placeholder values', () => {
			expect(findPlaceholderDetails('regular string')).toEqual([]);
			expect(findPlaceholderDetails(123)).toEqual([]);
			expect(findPlaceholderDetails(true)).toEqual([]);
			expect(findPlaceholderDetails(null)).toEqual([]);
		});

		it('returns empty array for empty object', () => {
			expect(findPlaceholderDetails({})).toEqual([]);
		});

		it('returns empty array for empty array', () => {
			expect(findPlaceholderDetails([])).toEqual([]);
		});

		it('finds placeholder at root level', () => {
			const result = findPlaceholderDetails('<__PLACEHOLDER_VALUE__Enter URL__>');
			expect(result).toEqual([{ path: [], label: 'Enter URL' }]);
		});

		it('finds placeholder in simple object', () => {
			const result = findPlaceholderDetails({
				url: '<__PLACEHOLDER_VALUE__Enter URL__>',
			});
			expect(result).toEqual([{ path: ['url'], label: 'Enter URL' }]);
		});

		it('finds multiple placeholders in object', () => {
			const result = findPlaceholderDetails({
				url: '<__PLACEHOLDER_VALUE__Enter URL__>',
				body: '<__PLACEHOLDER_VALUE__Enter Body__>',
			});
			expect(result).toHaveLength(2);
			expect(result).toContainEqual({ path: ['url'], label: 'Enter URL' });
			expect(result).toContainEqual({ path: ['body'], label: 'Enter Body' });
		});

		it('finds placeholder in nested object', () => {
			const result = findPlaceholderDetails({
				options: {
					headers: {
						authorization: '<__PLACEHOLDER_VALUE__Enter API Key__>',
					},
				},
			});
			expect(result).toEqual([
				{ path: ['options', 'headers', 'authorization'], label: 'Enter API Key' },
			]);
		});

		it('finds placeholder in array', () => {
			const result = findPlaceholderDetails([
				'regular value',
				'<__PLACEHOLDER_VALUE__Enter Value__>',
			]);
			expect(result).toEqual([{ path: ['[1]'], label: 'Enter Value' }]);
		});

		it('finds placeholder in array of objects', () => {
			const result = findPlaceholderDetails({
				headers: [
					{ name: 'Content-Type', value: 'application/json' },
					{ name: 'Authorization', value: '<__PLACEHOLDER_VALUE__Enter Token__>' },
				],
			});
			expect(result).toEqual([{ path: ['headers', '[1]', 'value'], label: 'Enter Token' }]);
		});

		it('finds placeholders in mixed structure', () => {
			const result = findPlaceholderDetails({
				url: '<__PLACEHOLDER_VALUE__Enter URL__>',
				options: {
					items: [{ key: '<__PLACEHOLDER_VALUE__Enter Key__>' }, { value: 'static' }],
				},
			});
			expect(result).toHaveLength(2);
			expect(result).toContainEqual({ path: ['url'], label: 'Enter URL' });
			expect(result).toContainEqual({
				path: ['options', 'items', '[0]', 'key'],
				label: 'Enter Key',
			});
		});

		it('ignores non-placeholder strings in object', () => {
			const result = findPlaceholderDetails({
				url: 'https://example.com',
				method: 'GET',
				placeholder: '<__PLACEHOLDER_VALUE__Enter Value__>',
			});
			expect(result).toEqual([{ path: ['placeholder'], label: 'Enter Value' }]);
		});

		it('handles custom starting path', () => {
			const result = findPlaceholderDetails({ url: '<__PLACEHOLDER_VALUE__Enter URL__>' }, [
				'parameters',
			]);
			expect(result).toEqual([{ path: ['parameters', 'url'], label: 'Enter URL' }]);
		});

		it('finds embedded placeholder in code string', () => {
			const result = findPlaceholderDetails({
				jsCode: "const apiKey = '<__PLACEHOLDER_VALUE__API_KEY__>';",
			});
			expect(result).toEqual([{ path: ['jsCode'], label: 'API_KEY' }]);
		});

		it('finds multiple embedded placeholders in code string', () => {
			const code = `
				const apiKey = '<__PLACEHOLDER_VALUE__API_KEY__>';
				const endpoint = '<__PLACEHOLDER_VALUE__API_ENDPOINT__>';
			`;
			const result = findPlaceholderDetails({ jsCode: code });
			expect(result).toHaveLength(2);
			expect(result).toContainEqual({ path: ['jsCode'], label: 'API_KEY' });
			expect(result).toContainEqual({ path: ['jsCode'], label: 'API_ENDPOINT' });
		});

		it('finds embedded placeholders in Code node parameters', () => {
			const result = findPlaceholderDetails({
				mode: 'runOnceForAllItems',
				language: 'javaScript',
				jsCode: `
					// Fetch data from API
					const response = await fetch('<__PLACEHOLDER_VALUE__API URL__>');
					return response.json();
				`,
			});
			expect(result).toEqual([{ path: ['jsCode'], label: 'API URL' }]);
		});

		it('finds embedded placeholders in Python code', () => {
			const result = findPlaceholderDetails({
				pythonCode: "api_key = '<__PLACEHOLDER_VALUE__Python API Key__>'",
			});
			expect(result).toEqual([{ path: ['pythonCode'], label: 'Python API Key' }]);
		});
	});

	describe('formatPlaceholderPath', () => {
		it('returns "parameters" for empty path', () => {
			expect(formatPlaceholderPath([])).toBe('parameters');
		});

		it('formats single segment path', () => {
			expect(formatPlaceholderPath(['url'])).toBe('url');
		});

		it('formats multi-segment path with dot notation', () => {
			expect(formatPlaceholderPath(['options', 'headers', 'authorization'])).toBe(
				'options.headers.authorization',
			);
		});

		it('formats path with array indices without leading dot', () => {
			expect(formatPlaceholderPath(['headers', '[0]', 'value'])).toBe('headers[0].value');
		});

		it('formats path starting with array index', () => {
			expect(formatPlaceholderPath(['[0]', 'key'])).toBe('[0].key');
		});

		it('formats path with multiple array indices', () => {
			expect(formatPlaceholderPath(['items', '[0]', 'options', '[1]', 'value'])).toBe(
				'items[0].options[1].value',
			);
		});

		it('formats path with consecutive array indices', () => {
			expect(formatPlaceholderPath(['matrix', '[0]', '[1]'])).toBe('matrix[0][1]');
		});
	});

	describe('isPlaceholderValue', () => {
		it('returns true for placeholder values', () => {
			expect(isPlaceholderValue('<__PLACEHOLDER_VALUE__API endpoint URL__>')).toBe(true);
			expect(isPlaceholderValue('<__PLACEHOLDER_VALUE__label__>')).toBe(true);
			expect(isPlaceholderValue('<__PLACEHOLDER_VALUE____>')).toBe(true);
		});

		it('returns false for non-placeholder strings', () => {
			expect(isPlaceholderValue('regular string')).toBe(false);
			expect(isPlaceholderValue('')).toBe(false);
			expect(isPlaceholderValue('https://api.example.com')).toBe(false);
			expect(isPlaceholderValue('={{ $json.field }}')).toBe(false);
		});

		it('returns false for malformed placeholders missing suffix', () => {
			// Has prefix but missing suffix - should be false
			expect(isPlaceholderValue('<__PLACEHOLDER_VALUE__missing suffix')).toBe(false);
			expect(isPlaceholderValue('<__PLACEHOLDER_VALUE__some text without end')).toBe(false);
		});

		it('returns false for malformed placeholders missing prefix', () => {
			// Has suffix but missing prefix - should be false
			expect(isPlaceholderValue('missing prefix__>')).toBe(false);
			expect(isPlaceholderValue('some text without start__>')).toBe(false);
		});

		it('returns false for non-string values', () => {
			expect(isPlaceholderValue(123)).toBe(false);
			expect(isPlaceholderValue(null)).toBe(false);
			expect(isPlaceholderValue(undefined)).toBe(false);
			expect(isPlaceholderValue({ key: 'value' })).toBe(false);
			expect(isPlaceholderValue(['array'])).toBe(false);
			expect(isPlaceholderValue(true)).toBe(false);
		});
	});

	describe('workflowTodos composable', () => {
		const createMockNode = (overrides: Partial<INodeUi> = {}): INodeUi =>
			({
				id: 'node-1',
				name: 'Test Node',
				type: 'n8n-nodes-base.httpRequest',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
				...overrides,
			}) as INodeUi;

		beforeEach(() => {
			setActivePinia(createPinia());
		});

		it('excludes placeholder issues from pinned nodes', () => {
			const workflowsStore = useWorkflowsStore();

			// Setup a node with placeholder in parameters
			const nodeWithPlaceholder = createMockNode({
				name: 'HTTP Request',
				parameters: {
					url: '<__PLACEHOLDER_VALUE__Enter URL__>',
				},
			});

			// Set the workflow with the node and pin data for it
			workflowsStore.workflow.nodes = [nodeWithPlaceholder];
			workflowsStore.workflow.pinData = {
				'HTTP Request': [{ json: { data: 'pinned result' } }],
			};

			const { workflowTodos } = useBuilderTodos();

			// Since the node has pinned data, the placeholder issue should be excluded
			expect(workflowTodos.value).toHaveLength(0);
		});

		it('includes placeholder issues from non-pinned nodes', () => {
			const workflowsStore = useWorkflowsStore();

			// Setup a node with placeholder in parameters
			const nodeWithPlaceholder = createMockNode({
				name: 'HTTP Request',
				parameters: {
					url: '<__PLACEHOLDER_VALUE__Enter URL__>',
				},
			});

			// Set the workflow with the node but NO pin data
			workflowsStore.workflow.nodes = [nodeWithPlaceholder];
			workflowsStore.workflow.pinData = {};

			const { workflowTodos } = useBuilderTodos();

			// Since the node has no pinned data, the placeholder issue should be included
			expect(workflowTodos.value).toHaveLength(1);
			expect(workflowTodos.value[0].node).toBe('HTTP Request');
		});

		it('excludes validation issues from pinned nodes', () => {
			const workflowsStore = useWorkflowsStore();

			// Setup a connected node with credential issues
			const nodeWithIssues = createMockNode({
				name: 'HTTP Request',
				issues: {
					credentials: {
						httpBasicAuth: ['Credentials not set'],
					},
				},
			});

			// Set the workflow with connections (node must be connected for issues to count)
			workflowsStore.workflow.nodes = [nodeWithIssues];
			workflowsStore.workflow.connections = {
				'HTTP Request': {
					main: [[{ node: 'Other Node', type: 'main' as const, index: 0 }]],
				},
			};
			workflowsStore.workflow.pinData = {
				'HTTP Request': [{ json: { data: 'pinned result' } }],
			};

			const { workflowTodos } = useBuilderTodos();

			// Since the node has pinned data, the credential issue should be excluded
			expect(workflowTodos.value).toHaveLength(0);
		});

		it('includes validation issues from non-pinned nodes', () => {
			const workflowsStore = useWorkflowsStore();

			// Setup a connected node with credential issues
			const nodeWithIssues = createMockNode({
				name: 'HTTP Request',
				issues: {
					credentials: {
						httpBasicAuth: ['Credentials not set'],
					},
				},
			});

			// Set the workflow with connections (node must be connected for issues to count)
			workflowsStore.workflow.nodes = [nodeWithIssues];
			workflowsStore.workflow.connections = {
				'HTTP Request': {
					main: [[{ node: 'Other Node', type: 'main' as const, index: 0 }]],
				},
			};
			workflowsStore.workflow.pinData = {};

			const { workflowTodos } = useBuilderTodos();

			// Since the node has no pinned data, the credential issue should be included
			expect(workflowTodos.value).toHaveLength(1);
			expect(workflowTodos.value[0].node).toBe('HTTP Request');
		});

		it('handles mixed pinned and non-pinned nodes correctly', () => {
			const workflowsStore = useWorkflowsStore();

			// Setup two nodes: one pinned with issues, one not pinned with issues
			const pinnedNode = createMockNode({
				name: 'Pinned Node',
				parameters: {
					url: '<__PLACEHOLDER_VALUE__Enter URL__>',
				},
			});

			const unpinnedNode = createMockNode({
				name: 'Unpinned Node',
				parameters: {
					apiKey: '<__PLACEHOLDER_VALUE__Enter API Key__>',
				},
			});

			workflowsStore.workflow.nodes = [pinnedNode, unpinnedNode];
			workflowsStore.workflow.pinData = {
				'Pinned Node': [{ json: { data: 'pinned result' } }],
				// 'Unpinned Node' has no pinned data
			};

			const { workflowTodos } = useBuilderTodos();

			// Only the unpinned node's issue should be included
			expect(workflowTodos.value).toHaveLength(1);
			expect(workflowTodos.value[0].node).toBe('Unpinned Node');
		});
	});
});
