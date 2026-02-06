import { describe, it, expect, vi } from 'vitest';
import { createTestingPinia } from '@pinia/testing';
import { createComponentRenderer } from '@/__tests__/render';
import FocusedNodeChip from './FocusedNodeChip.vue';
import type { FocusedNode } from '../../focusedNodes.types';

// Mock NodeIcon
vi.mock('@/app/components/NodeIcon.vue', () => ({
	default: {
		name: 'NodeIcon',
		template: '<div data-test-id="node-icon" />',
		props: ['nodeType', 'size'],
	},
}));

const renderComponent = createComponentRenderer(FocusedNodeChip);

const createConfirmedNode = (name = 'HTTP Request'): FocusedNode => ({
	nodeId: 'node-1',
	nodeName: name,
	nodeType: 'n8n-nodes-base.httpRequest',
	state: 'confirmed',
});

const createUnconfirmedNode = (name = 'HTTP Request'): FocusedNode => ({
	nodeId: 'node-1',
	nodeName: name,
	nodeType: 'n8n-nodes-base.httpRequest',
	state: 'unconfirmed',
});

describe('FocusedNodeChip', () => {
	describe('confirmed state', () => {
		it('should render the node name', () => {
			const { getByText } = renderComponent({
				props: { node: createConfirmedNode() },
				pinia: createTestingPinia(),
			});

			expect(getByText('HTTP Request')).toBeInTheDocument();
		});

		it('should show NodeIcon', () => {
			const { getByTestId } = renderComponent({
				props: { node: createConfirmedNode() },
				pinia: createTestingPinia(),
			});

			expect(getByTestId('node-icon')).toBeInTheDocument();
		});

		it('should show remove button', () => {
			const { container } = renderComponent({
				props: { node: createConfirmedNode() },
				pinia: createTestingPinia(),
			});

			const removeButton = container.querySelector('button');
			expect(removeButton).toBeInTheDocument();
		});

		it('should emit click on chip click', async () => {
			const { container, emitted } = renderComponent({
				props: { node: createConfirmedNode() },
				pinia: createTestingPinia(),
			});

			const chip = container.querySelector('span');
			await chip?.click();

			expect(emitted().click).toBeTruthy();
		});

		it('should emit remove on button click', async () => {
			const { container, emitted } = renderComponent({
				props: { node: createConfirmedNode() },
				pinia: createTestingPinia(),
			});

			const removeButton = container.querySelector('button');
			await removeButton?.click();

			expect(emitted().remove).toBeTruthy();
		});
	});

	describe('unconfirmed state', () => {
		it('should render with unconfirmed styling', () => {
			const { container } = renderComponent({
				props: { node: createUnconfirmedNode() },
				pinia: createTestingPinia(),
			});

			const chip = container.querySelector('span');
			expect(chip?.className).toContain('unconfirmed');
		});

		it('should not show remove button', () => {
			const { container } = renderComponent({
				props: { node: createUnconfirmedNode() },
				pinia: createTestingPinia(),
			});

			const removeButton = container.querySelector('button');
			expect(removeButton).not.toBeInTheDocument();
		});

		it('should emit click on chip click', async () => {
			const { container, emitted } = renderComponent({
				props: { node: createUnconfirmedNode() },
				pinia: createTestingPinia(),
			});

			const chip = container.querySelector('span');
			await chip?.click();

			expect(emitted().click).toBeTruthy();
		});
	});

	describe('truncation', () => {
		it('should truncate names longer than 20 characters', () => {
			const { getByText } = renderComponent({
				props: { node: createConfirmedNode('A Very Long Node Name Here') },
				pinia: createTestingPinia(),
			});

			expect(getByText('A Very Long Node Na...')).toBeInTheDocument();
		});

		it('should not truncate names with 20 or fewer characters', () => {
			const { getByText } = renderComponent({
				props: { node: createConfirmedNode('Short Name') },
				pinia: createTestingPinia(),
			});

			expect(getByText('Short Name')).toBeInTheDocument();
		});
	});
});
