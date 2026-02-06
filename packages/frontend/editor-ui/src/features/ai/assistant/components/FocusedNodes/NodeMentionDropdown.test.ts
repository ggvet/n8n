import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { nextTick } from 'vue';
import { createComponentRenderer } from '@/__tests__/render';
import NodeMentionDropdown from './NodeMentionDropdown.vue';
import type { INodeUi } from '@/Interface';

// Mock NodeIcon
vi.mock('@/app/components/NodeIcon.vue', () => ({
	default: {
		name: 'NodeIcon',
		template: '<div data-test-id="node-icon" />',
		props: ['nodeType', 'size'],
	},
}));

// Mock i18n
vi.mock('@n8n/i18n', async (importOriginal) => ({
	...(await importOriginal()),
	useI18n: () => ({
		baseText: (key: string, opts?: { interpolate?: Record<string, unknown> }) =>
			opts?.interpolate ? `${key}:${JSON.stringify(opts.interpolate)}` : key,
	}),
}));

// Mock Teleport to render inline
vi.mock('vue', async (importOriginal) => {
	const actual = await importOriginal<typeof import('vue')>();
	return {
		...actual,
		Teleport: actual.defineComponent({
			setup(_, { slots }) {
				return () => slots.default?.();
			},
		}),
	};
});

const createMockNode = (id: string, name: string, type = 'n8n-nodes-base.httpRequest'): INodeUi =>
	({
		id,
		name,
		type,
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	}) as INodeUi;

const renderComponent = createComponentRenderer(NodeMentionDropdown, {
	global: {
		stubs: {
			Teleport: true,
		},
	},
});

describe('NodeMentionDropdown', () => {
	const defaultNodes = [
		createMockNode('node-1', 'HTTP Request'),
		createMockNode('node-2', 'Code Node', 'n8n-nodes-base.code'),
		createMockNode('node-3', 'Set Data', 'n8n-nodes-base.set'),
	];

	const defaultProps = {
		nodes: defaultNodes,
		selectedNodeIds: [],
		highlightedIndex: 0,
		position: { top: 100, left: 50 },
		searchQuery: '',
		viaButton: false,
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('rendering', () => {
		it('should render node list with names', () => {
			const { getByText } = renderComponent({
				props: defaultProps,
				pinia: createTestingPinia(),
			});

			expect(getByText('HTTP Request')).toBeInTheDocument();
			expect(getByText('Code Node')).toBeInTheDocument();
			expect(getByText('Set Data')).toBeInTheDocument();
		});

		it('should show empty state when no nodes', () => {
			const { container } = renderComponent({
				props: { ...defaultProps, nodes: [], searchQuery: 'nonexistent' },
				pinia: createTestingPinia(),
			});

			// Check that the empty state div is present
			const emptyState = container.querySelector('[class*="emptyState"]');
			expect(emptyState).toBeInTheDocument();
		});

		it('should render node icons', () => {
			const { getAllByTestId } = renderComponent({
				props: defaultProps,
				pinia: createTestingPinia(),
			});

			expect(getAllByTestId('node-icon')).toHaveLength(3);
		});
	});

	describe('search (viaButton)', () => {
		it('should show search input when viaButton=true', () => {
			const { container } = renderComponent({
				props: { ...defaultProps, viaButton: true },
				pinia: createTestingPinia(),
			});

			const input = container.querySelector('input[type="text"]');
			expect(input).toBeInTheDocument();
		});

		it('should hide search input when viaButton=false', () => {
			const { container } = renderComponent({
				props: { ...defaultProps, viaButton: false },
				pinia: createTestingPinia(),
			});

			const input = container.querySelector('input[type="text"]');
			expect(input).not.toBeInTheDocument();
		});
	});

	describe('interactions', () => {
		it('should emit select on node click', async () => {
			const { getByText, emitted } = renderComponent({
				props: defaultProps,
				pinia: createTestingPinia(),
			});

			await getByText('HTTP Request').parentElement?.click();

			expect(emitted().select).toBeTruthy();
			expect(emitted().select[0][0]).toEqual(defaultNodes[0]);
		});

		it('should emit highlight on mouseenter', async () => {
			const { container, emitted } = renderComponent({
				props: defaultProps,
				pinia: createTestingPinia(),
			});

			const items = container.querySelectorAll('[data-mention-item]');
			await items[1].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));

			expect(emitted().highlight).toBeTruthy();
			expect(emitted().highlight[0][0]).toBe(1);
		});
	});

	describe('positioning', () => {
		it('should apply left alignment by default', () => {
			const { container } = renderComponent({
				props: { ...defaultProps, position: { top: 100, left: 50 } },
				pinia: createTestingPinia(),
			});

			const dropdown = container.querySelector('[data-node-mention-dropdown]') as HTMLElement;
			expect(dropdown?.style.left).toBe('50px');
			expect(dropdown?.style.top).toBe('100px');
		});

		it('should apply right alignment when specified', () => {
			const { container } = renderComponent({
				props: { ...defaultProps, position: { top: 100, right: 20 } },
				pinia: createTestingPinia(),
			});

			const dropdown = container.querySelector('[data-node-mention-dropdown]') as HTMLElement;
			expect(dropdown?.style.right).toBe('20px');
		});

		it('should apply translateY(-100%)', () => {
			const { container } = renderComponent({
				props: defaultProps,
				pinia: createTestingPinia(),
			});

			const dropdown = container.querySelector('[data-node-mention-dropdown]') as HTMLElement;
			expect(dropdown?.style.transform).toBe('translateY(-100%)');
		});
	});

	describe('selected nodes', () => {
		it('should apply selected styling to selected nodes', () => {
			const { container } = renderComponent({
				props: { ...defaultProps, selectedNodeIds: ['node-1'] },
				pinia: createTestingPinia(),
			});

			const items = container.querySelectorAll('[data-mention-item]');
			expect(items[0].className).toContain('selected');
			expect(items[1].className).not.toContain('selected');
		});
	});

	describe('highlighted index', () => {
		it('should apply highlighted styling', () => {
			const { container } = renderComponent({
				props: { ...defaultProps, highlightedIndex: 1 },
				pinia: createTestingPinia(),
			});

			const items = container.querySelectorAll('[data-mention-item]');
			expect(items[1].className).toContain('highlighted');
			expect(items[0].className).not.toContain('highlighted');
		});
	});

	describe('search query sync', () => {
		it('should emit update:searchQuery when local query changes', async () => {
			const { container, emitted } = renderComponent({
				props: { ...defaultProps, viaButton: true },
				pinia: createTestingPinia(),
			});

			const input = container.querySelector('input[type="text"]') as HTMLInputElement;
			if (input) {
				input.value = 'test';
				input.dispatchEvent(new Event('input', { bubbles: true }));
				await nextTick();
			}

			expect(emitted()['update:searchQuery']).toBeTruthy();
		});
	});
});
