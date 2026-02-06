import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia } from 'pinia';
import { createTestingPinia } from '@pinia/testing';
import { nextTick } from 'vue';

import { useNodeMention } from './useNodeMention';
import { useFocusedNodesStore } from '../focusedNodes.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { mockedStore } from '@/__tests__/utils';
import type { INodeUi } from '@/Interface';

// Mock posthog
vi.mock('@/app/stores/posthog.store', () => ({
	usePostHog: () => ({
		isFeatureEnabled: () => true,
	}),
}));

// Mock useDebounceFn
vi.mock('@vueuse/core', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@vueuse/core')>();
	return {
		...actual,
		useDebounceFn: (fn: (...args: unknown[]) => void) => fn,
	};
});

// Mock telemetry
vi.mock('@/app/composables/useTelemetry', () => ({
	useTelemetry: () => ({ track: vi.fn() }),
}));

// Mock vue-router
vi.mock('vue-router', () => ({
	useRoute: vi.fn(() => ({ path: '/', params: {}, name: 'NodeView' })),
	useRouter: vi.fn(),
	RouterLink: vi.fn(),
}));

const createMockNode = (id: string, name: string, type = 'n8n-nodes-base.httpRequest'): INodeUi =>
	({
		id,
		name,
		type,
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	}) as INodeUi;

function createMockInput(value = '', selectionStart = 0): HTMLInputElement {
	const input = document.createElement('input');
	// Set initial value directly (before any Object.defineProperty)
	input.value = value;

	// Track selectionStart via a mutable variable
	let _selectionStart = selectionStart;
	Object.defineProperty(input, 'selectionStart', {
		get: () => _selectionStart,
		set: (v: number) => {
			_selectionStart = v;
		},
		configurable: true,
	});

	input.getBoundingClientRect = () =>
		({ top: 100, left: 50, right: 350, bottom: 120, width: 300, height: 20 }) as DOMRect;
	input.setSelectionRange = vi.fn();
	input.dispatchEvent = vi.fn().mockReturnValue(true);
	return input;
}

describe('useNodeMention', () => {
	let focusedNodesStore: ReturnType<typeof useFocusedNodesStore>;
	let workflowsStore: ReturnType<typeof mockedStore<typeof useWorkflowsStore>>;

	beforeEach(() => {
		vi.clearAllMocks();

		setActivePinia(
			createTestingPinia({
				createSpy: vi.fn,
				stubActions: false,
			}),
		);

		workflowsStore = mockedStore(useWorkflowsStore);
		workflowsStore.allNodes = [
			createMockNode('node-1', 'HTTP Request'),
			createMockNode('node-2', 'Code Node', 'n8n-nodes-base.code'),
			createMockNode('node-3', 'Set Data', 'n8n-nodes-base.set'),
		];

		focusedNodesStore = useFocusedNodesStore();
	});

	describe('filteredNodes', () => {
		it('should exclude confirmed nodes', () => {
			focusedNodesStore.confirmNodes(['node-1'], 'context_menu');

			const { filteredNodes } = useNodeMention();

			const ids = filteredNodes.value.map((n) => n.id);
			expect(ids).not.toContain('node-1');
			expect(ids).toContain('node-2');
			expect(ids).toContain('node-3');
		});

		it('should filter by searchQuery (case insensitive)', () => {
			const { filteredNodes, searchQuery } = useNodeMention();

			searchQuery.value = 'code';

			expect(filteredNodes.value).toHaveLength(1);
			expect(filteredNodes.value[0].name).toBe('Code Node');
		});

		it('should limit to maxResults', () => {
			const { filteredNodes } = useNodeMention({ maxResults: 2 });

			expect(filteredNodes.value.length).toBeLessThanOrEqual(2);
		});

		it('should return empty when all confirmed', () => {
			focusedNodesStore.confirmNodes(['node-1', 'node-2', 'node-3'], 'context_menu');

			const { filteredNodes } = useNodeMention();

			expect(filteredNodes.value).toHaveLength(0);
		});
	});

	describe('handleInput', () => {
		it('should open dropdown when @ is typed', () => {
			const { handleInput, showDropdown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			expect(showDropdown.value).toBe(true);
		});

		it('should update searchQuery as user types after @', () => {
			const { handleInput, showDropdown, searchQuery } = useNodeMention();

			// Type @ first
			const input1 = createMockInput('@', 1);
			handleInput({} as InputEvent, input1);
			expect(showDropdown.value).toBe(true);

			// Continue typing
			const input2 = createMockInput('@co', 3);
			// Need to use same input ref, so simulate continuing typing
			Object.defineProperty(input1, 'value', { value: '@co', configurable: true });
			Object.defineProperty(input1, 'selectionStart', {
				get: () => 3,
				configurable: true,
			});
			handleInput({} as InputEvent, input1);

			expect(searchQuery.value).toBe('co');
		});

		it('should close when cursor moves before @', () => {
			const { handleInput, showDropdown } = useNodeMention();

			// Open dropdown
			const input = createMockInput('@test', 5);
			handleInput({} as InputEvent, input);

			// Move cursor before @
			Object.defineProperty(input, 'selectionStart', {
				get: () => 0,
				set: () => {},
				configurable: true,
			});
			handleInput({} as InputEvent, input);

			expect(showDropdown.value).toBe(false);
		});

		it('should close when @ is deleted', () => {
			const { handleInput, showDropdown } = useNodeMention();

			// Open dropdown
			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);
			expect(showDropdown.value).toBe(true);

			// Delete @
			input.value = '';
			Object.defineProperty(input, 'selectionStart', {
				get: () => 0,
				set: () => {},
				configurable: true,
			});
			handleInput({} as InputEvent, input);

			expect(showDropdown.value).toBe(false);
		});
	});

	describe('handleKeyDown', () => {
		it('should return false when dropdown is hidden', () => {
			const { handleKeyDown } = useNodeMention();

			const result = handleKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' }));

			expect(result).toBe(false);
		});

		it('should navigate down with ArrowDown', () => {
			const { handleInput, handleKeyDown, highlightedIndex } = useNodeMention();

			// Open dropdown
			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const event = new KeyboardEvent('keydown', { key: 'ArrowDown' });
			vi.spyOn(event, 'preventDefault');
			const result = handleKeyDown(event);

			expect(result).toBe(true);
			expect(highlightedIndex.value).toBe(1);
			expect(event.preventDefault).toHaveBeenCalled();
		});

		it('should navigate up with ArrowUp (clamped to 0)', () => {
			const { handleInput, handleKeyDown, highlightedIndex } = useNodeMention();

			// Open dropdown
			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const event = new KeyboardEvent('keydown', { key: 'ArrowUp' });
			vi.spyOn(event, 'preventDefault');
			handleKeyDown(event);

			expect(highlightedIndex.value).toBe(0);
		});

		it('should select highlighted node on Enter', () => {
			const { handleInput, handleKeyDown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const event = new KeyboardEvent('keydown', { key: 'Enter' });
			vi.spyOn(event, 'preventDefault');
			vi.spyOn(event, 'stopPropagation');
			const result = handleKeyDown(event);

			expect(result).toBe(true);
			expect(event.preventDefault).toHaveBeenCalled();
		});

		it('should return false on Enter when no nodes', () => {
			// Confirm all nodes first
			focusedNodesStore.confirmNodes(['node-1', 'node-2', 'node-3'], 'context_menu');

			const { handleInput, handleKeyDown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const result = handleKeyDown(new KeyboardEvent('keydown', { key: 'Enter' }));

			expect(result).toBe(false);
		});

		it('should close on Escape', () => {
			const { handleInput, handleKeyDown, showDropdown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const event = new KeyboardEvent('keydown', { key: 'Escape' });
			vi.spyOn(event, 'preventDefault');
			const result = handleKeyDown(event);

			expect(result).toBe(true);
			expect(showDropdown.value).toBe(false);
		});

		it('should select on Tab when nodes available', () => {
			const { handleInput, handleKeyDown, showDropdown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const event = new KeyboardEvent('keydown', { key: 'Tab' });
			vi.spyOn(event, 'preventDefault');
			const result = handleKeyDown(event);

			expect(result).toBe(true);
			expect(showDropdown.value).toBe(false);
		});

		it('should close on Tab when no nodes', () => {
			focusedNodesStore.confirmNodes(['node-1', 'node-2', 'node-3'], 'context_menu');

			const { handleInput, handleKeyDown, showDropdown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const result = handleKeyDown(new KeyboardEvent('keydown', { key: 'Tab' }));

			expect(result).toBe(false);
			expect(showDropdown.value).toBe(false);
		});

		it('should return false for unhandled keys', () => {
			const { handleInput, handleKeyDown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			const result = handleKeyDown(new KeyboardEvent('keydown', { key: 'a' }));

			expect(result).toBe(false);
		});
	});

	describe('selectNode', () => {
		it('should call confirmNodes with mention source', () => {
			const confirmSpy = vi.spyOn(focusedNodesStore, 'confirmNodes');
			const { selectNode } = useNodeMention();

			selectNode(workflowsStore.allNodes[0]);

			expect(confirmSpy).toHaveBeenCalledWith(['node-1'], 'mention');
		});

		it('should close dropdown after selection', () => {
			const { handleInput, selectNode, showDropdown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);
			expect(showDropdown.value).toBe(true);

			selectNode(workflowsStore.allNodes[0]);

			expect(showDropdown.value).toBe(false);
		});

		it('should remove @query from input and dispatch event', () => {
			const { handleInput, selectNode } = useNodeMention();

			// Use same input for both calls
			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			// Simulate user typing more after @
			input.value = '@co';
			Object.defineProperty(input, 'selectionStart', {
				get: () => 3,
				set: () => {},
				configurable: true,
			});
			handleInput({} as InputEvent, input);

			selectNode(workflowsStore.allNodes[1]);

			expect(input.setSelectionRange).toHaveBeenCalled();
			expect(input.dispatchEvent).toHaveBeenCalled();
		});
	});

	describe('closeDropdown', () => {
		it('should reset state', () => {
			const { handleInput, closeDropdown, showDropdown, searchQuery, highlightedIndex } =
				useNodeMention();

			const input = createMockInput('@test', 5);
			handleInput({} as InputEvent, input);

			closeDropdown();

			expect(showDropdown.value).toBe(false);
			expect(searchQuery.value).toBe('');
			expect(highlightedIndex.value).toBe(0);
		});

		it('should remove text from input when removeQueryFromInput=true', () => {
			const { handleInput, closeDropdown } = useNodeMention();

			// First open with @, then type more
			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);

			input.value = '@test';
			Object.defineProperty(input, 'selectionStart', {
				get: () => 5,
				set: () => {},
				configurable: true,
			});
			handleInput({} as InputEvent, input);

			closeDropdown(true);

			expect(input.setSelectionRange).toHaveBeenCalled();
			expect(input.dispatchEvent).toHaveBeenCalled();
		});
	});

	describe('openDropdown', () => {
		it('should set showDropdown and calculate position', () => {
			const { openDropdown, showDropdown, dropdownPosition } = useNodeMention();

			const input = createMockInput('', 0);
			openDropdown(input);

			expect(showDropdown.value).toBe(true);
			expect(dropdownPosition.value.top).toBe(92); // rect.top - 8
		});

		it('should set inputRef=null in viaButton mode', () => {
			const { openDropdown, openedViaButton } = useNodeMention();

			const button = document.createElement('button');
			button.getBoundingClientRect = () =>
				({ top: 100, left: 50, right: 350, bottom: 120, width: 300, height: 20 }) as DOMRect;
			openDropdown(button, { viaButton: true });

			expect(openedViaButton.value).toBe(true);
		});

		it('should use alignRight option', () => {
			const { openDropdown, dropdownPosition } = useNodeMention();

			const input = createMockInput('', 0);
			openDropdown(input, { alignRight: true });

			expect(dropdownPosition.value.right).toBeDefined();
			expect(dropdownPosition.value.left).toBeUndefined();
		});
	});

	describe('watcher', () => {
		it('should close dropdown when allNodes length changes', async () => {
			const { handleInput, showDropdown } = useNodeMention();

			const input = createMockInput('@', 1);
			handleInput({} as InputEvent, input);
			expect(showDropdown.value).toBe(true);

			// Change allNodes
			workflowsStore.allNodes = [...workflowsStore.allNodes, createMockNode('node-4', 'New Node')];
			await nextTick();

			expect(showDropdown.value).toBe(false);
		});
	});
});
