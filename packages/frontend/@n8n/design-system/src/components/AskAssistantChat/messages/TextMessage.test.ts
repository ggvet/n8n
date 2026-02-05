import { render, fireEvent } from '@testing-library/vue';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';

import TextMessage from './TextMessage.vue';
import type * as UseMarkdownModule from './useMarkdown';
import { parseThinkingSegments } from './useMarkdown';
import type { ChatUI } from '../../../types/assistant';

// Mock i18n to return keys instead of translated text
vi.mock('@n8n/design-system/composables/useI18n', () => ({
	useI18n: () => ({
		t: (key: string) => key,
	}),
}));

// Mock useMarkdown but not parseThinkingSegments
vi.mock('./useMarkdown', async (importOriginal) => {
	const original = await importOriginal<typeof UseMarkdownModule>();
	return {
		...original,
		useMarkdown: () => ({
			renderMarkdown: (content: string) => `<p>${content}</p>`,
		}),
	};
});

// Mock vueuse composables for RestoreVersionLink
vi.mock('@vueuse/core', () => ({
	onClickOutside: vi.fn(),
	useElementBounding: vi.fn(() => ({
		bottom: { value: 100 },
		right: { value: 200 },
		width: { value: 150 },
	})),
}));

const stubs = {
	BaseMessage: {
		template: '<div data-test-id="base-message-stub"><slot /></div>',
		props: ['message', 'isFirstOfRole', 'user'],
	},
	BlinkingCursor: true,
	N8nButton: true,
	N8nIcon: true,
	RestoreVersionConfirm: {
		name: 'RestoreVersionConfirm',
		props: ['versionId', 'pruneTimeHours'],
		emits: ['confirm', 'cancel', 'showVersion'],
		template: `
			<div data-test-id="restore-version-confirm-stub">
				<button data-test-id="confirm-restore" @click="$emit('confirm')">Confirm</button>
				<button data-test-id="cancel-restore" @click="$emit('cancel')">Cancel</button>
				<button data-test-id="show-version" @click="$emit('showVersion', versionId)">Show</button>
			</div>
		`,
	},
	Teleport: {
		template: '<div data-test-id="teleport-stub"><slot /></div>',
	},
};

const directives = {
	n8nHtml: (el: HTMLElement, binding: { value: string }) => {
		el.innerHTML = binding.value;
	},
};

beforeEach(() => {
	setActivePinia(createPinia());
});

describe('TextMessage', () => {
	const createUserMessage = (
		overrides: Partial<ChatUI.TextMessage> = {},
	): ChatUI.TextMessage & { id: string; read: boolean } => ({
		id: 'msg-1',
		type: 'text',
		role: 'user',
		content: 'Test user message content',
		read: true,
		...overrides,
	});

	const createAssistantMessage = (
		overrides: Partial<ChatUI.TextMessage> = {},
	): ChatUI.TextMessage & { id: string; read: boolean } => ({
		id: 'msg-1',
		type: 'text',
		role: 'assistant',
		content: 'Test assistant message content',
		read: true,
		...overrides,
	});

	describe('basic rendering', () => {
		it('should render user message correctly', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage(),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			expect(wrapper.getByTestId('base-message-stub')).toBeTruthy();
			expect(wrapper.container.textContent).toContain('Test user message content');
		});

		it('should render assistant message correctly', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage(),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			expect(wrapper.container.textContent).toContain('Test assistant message content');
		});

		it('should apply userMessage class for user role', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage(),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			const textMessage = wrapper.container.querySelector('[class*="userMessage"]');
			expect(textMessage).toBeTruthy();
		});
	});

	describe('RestoreVersionLink integration', () => {
		it('should render RestoreVersionLink when user message has revertVersion', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage({
						revertVersion: {
							id: 'version-123',
							createdAt: new Date().toISOString(),
						},
					}),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			// RestoreVersionLink should be rendered (check for its structure)
			const restoreWrapper = wrapper.container.querySelector('[class*="restoreWrapper"]');
			expect(restoreWrapper).toBeTruthy();
		});

		it('should not render RestoreVersionLink when user message has no revertVersion', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage(),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			const restoreWrapper = wrapper.container.querySelector('[class*="restoreWrapper"]');
			expect(restoreWrapper).toBeFalsy();
		});

		it('should not render RestoreVersionLink for assistant messages even with revertVersion', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage({
						revertVersion: {
							id: 'version-123',
							createdAt: new Date().toISOString(),
						},
					}),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			const restoreWrapper = wrapper.container.querySelector('[class*="restoreWrapper"]');
			expect(restoreWrapper).toBeFalsy();
		});

		it('should pass streaming prop to RestoreVersionLink', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage({
						revertVersion: {
							id: 'version-123',
							createdAt: new Date().toISOString(),
						},
					}),
					isFirstOfRole: true,
					streaming: true,
				},
				global: { stubs, directives },
			});

			// When streaming, the restore button should be disabled
			const button = wrapper.container.querySelector('[class*="restoreWrapper"] button[disabled]');
			expect(button).toBeTruthy();
		});

		it('should pass pruneTimeHours prop to RestoreVersionLink', async () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage({
						revertVersion: {
							id: 'version-123',
							createdAt: new Date().toISOString(),
						},
					}),
					isFirstOfRole: true,
					pruneTimeHours: 72,
				},
				global: { stubs, directives },
			});

			// Click to open the confirm dialog
			const restoreButton = wrapper.container.querySelector('[class*="restoreWrapper"] button');
			expect(restoreButton).toBeTruthy();
			await fireEvent.click(restoreButton!);
			await nextTick();

			// Verify the confirm dialog is shown
			expect(wrapper.queryByTestId('restore-version-confirm-stub')).toBeTruthy();
		});

		it('should emit restoreConfirm with versionId and messageId when confirm is triggered', async () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage({
						id: 'msg-abc',
						revertVersion: {
							id: 'version-xyz',
							createdAt: new Date().toISOString(),
						},
					}),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			// Open the confirm dialog
			const restoreButton = wrapper.container.querySelector('[class*="restoreWrapper"] button');
			await fireEvent.click(restoreButton!);
			await nextTick();

			// Click confirm
			const confirmButton = wrapper.getByTestId('confirm-restore');
			await fireEvent.click(confirmButton);
			await nextTick();

			expect(wrapper.emitted()).toHaveProperty('restoreConfirm');
			expect(wrapper.emitted().restoreConfirm[0]).toEqual(['version-xyz', 'msg-abc']);
		});

		it('should emit restoreCancel when cancel is triggered', async () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage({
						revertVersion: {
							id: 'version-123',
							createdAt: new Date().toISOString(),
						},
					}),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			// Open the confirm dialog
			const restoreButton = wrapper.container.querySelector('[class*="restoreWrapper"] button');
			await fireEvent.click(restoreButton!);
			await nextTick();

			// Click cancel
			const cancelButton = wrapper.getByTestId('cancel-restore');
			await fireEvent.click(cancelButton);
			await nextTick();

			expect(wrapper.emitted()).toHaveProperty('restoreCancel');
		});

		it('should emit showVersion with versionId when show version is triggered', async () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage({
						revertVersion: {
							id: 'version-show-test',
							createdAt: new Date().toISOString(),
						},
					}),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			// Open the confirm dialog
			const restoreButton = wrapper.container.querySelector('[class*="restoreWrapper"] button');
			await fireEvent.click(restoreButton!);
			await nextTick();

			// Click show version
			const showButton = wrapper.getByTestId('show-version');
			await fireEvent.click(showButton);
			await nextTick();

			expect(wrapper.emitted()).toHaveProperty('showVersion');
			expect(wrapper.emitted().showVersion[0]).toEqual(['version-show-test']);
		});
	});

	describe('user message expand/collapse', () => {
		it('should not show expand button for short messages', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage({ content: 'Short message' }),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			const showMoreButton = wrapper.container.querySelector('[class*="showMoreButton"]');
			expect(showMoreButton).toBeFalsy();
		});
	});

	describe('code snippet rendering', () => {
		it('should render code snippet when provided', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage({
						codeSnippet: 'const x = 1;',
					}),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			expect(wrapper.getByTestId('assistant-code-snippet')).toBeTruthy();
		});

		it('should not render code snippet when not provided', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage(),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			expect(wrapper.queryByTestId('assistant-code-snippet')).toBeFalsy();
		});
	});

	describe('streaming indicator', () => {
		it('should show blinking cursor for streaming assistant messages that are last', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage(),
					isFirstOfRole: true,
					streaming: true,
					isLastMessage: true,
				},
				global: { stubs, directives },
			});

			// BlinkingCursor should be rendered (stubbed as true, so just check it's there)
			const html = wrapper.html();
			expect(html).toContain('blinking-cursor');
		});

		it('should not show blinking cursor for user messages', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createUserMessage(),
					isFirstOfRole: true,
					streaming: true,
					isLastMessage: true,
				},
				global: { stubs, directives },
			});

			// BlinkingCursor should not be rendered for user messages
			const html = wrapper.html();
			expect(html).not.toContain('blinking-cursor');
		});

		it('should not show blinking cursor when not streaming', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage(),
					isFirstOfRole: true,
					streaming: false,
					isLastMessage: true,
				},
				global: { stubs, directives },
			});

			const html = wrapper.html();
			expect(html).not.toContain('blinking-cursor');
		});
	});

	describe('custom color', () => {
		it('should apply custom color to assistant text', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage(),
					isFirstOfRole: true,
					color: 'red',
				},
				global: { stubs, directives },
			});

			const assistantText = wrapper.container.querySelector('[class*="assistantText"]');
			expect(assistantText?.getAttribute('style')).toContain('color: red');
		});

		it('should not apply style when color is not provided', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage(),
					isFirstOfRole: true,
				},
				global: { stubs, directives },
			});

			const assistantText = wrapper.container.querySelector('[class*="assistantText"]');
			expect(assistantText?.getAttribute('style')).toBeFalsy();
		});
	});

	describe('thinking tag rendering', () => {
		it('should render collapsible section for messages with thinking tags when enabled', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage({
						content: 'Hello <thinking>This is my thought process</thinking> World',
					}),
					isFirstOfRole: true,
					enableThinkingParse: true,
				},
				global: { stubs, directives },
			});

			// Check that details element is rendered
			const details = wrapper.container.querySelector('details.n8n-thinking-section');
			expect(details).toBeTruthy();

			// Check summary text contains the i18n key
			const summary = details?.querySelector('summary');
			expect(summary?.textContent).toContain('assistantChat.thinking.thinking');

			// Check that the thinking content is rendered inside
			expect(details?.textContent).toContain('This is my thought process');

			// Check that text before and after is rendered
			expect(wrapper.container.textContent).toContain('Hello');
			expect(wrapper.container.textContent).toContain('World');
		});

		it('should render message without thinking tags normally', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage({
						content: 'Just a normal message',
					}),
					isFirstOfRole: true,
					enableThinkingParse: true,
				},
				global: { stubs, directives },
			});

			// No details element should be rendered
			const details = wrapper.container.querySelector('details.n8n-thinking-section');
			expect(details).toBeFalsy();

			// Content should be rendered normally
			expect(wrapper.container.textContent).toContain('Just a normal message');
		});

		it('should hide incomplete thinking tags during streaming when enabled', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage({
						content: 'Starting response <thinking>Partial thought...',
					}),
					isFirstOfRole: true,
					streaming: true,
					isLastMessage: true,
					enableThinkingParse: true,
				},
				global: { stubs, directives },
			});

			// Text before incomplete tag should be visible
			expect(wrapper.container.textContent).toContain('Starting response');

			// The incomplete tag and content after should not be visible
			expect(wrapper.container.textContent).not.toContain('<thinking>');
			expect(wrapper.container.textContent).not.toContain('Partial thought');
		});

		it('should render multiple thinking sections correctly when enabled', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage({
						content:
							'First <thinking>Thought 1</thinking> Middle <thinking>Thought 2</thinking> Last',
					}),
					isFirstOfRole: true,
					enableThinkingParse: true,
				},
				global: { stubs, directives },
			});

			// Should have two details elements
			const details = wrapper.container.querySelectorAll('details.n8n-thinking-section');
			expect(details.length).toBe(2);

			// Both thoughts should be present
			expect(wrapper.container.textContent).toContain('Thought 1');
			expect(wrapper.container.textContent).toContain('Thought 2');

			// Text between should be present
			expect(wrapper.container.textContent).toContain('First');
			expect(wrapper.container.textContent).toContain('Middle');
			expect(wrapper.container.textContent).toContain('Last');
		});

		it('should not parse thinking tags when enableThinkingParse is false', () => {
			const wrapper = render(TextMessage, {
				props: {
					message: createAssistantMessage({
						content: 'Hello <thinking>This is my thought process</thinking> World',
					}),
					isFirstOfRole: true,
					enableThinkingParse: false,
				},
				global: { stubs, directives },
			});

			// No details element should be rendered when thinking parse is disabled
			const details = wrapper.container.querySelector('details.n8n-thinking-section');
			expect(details).toBeFalsy();

			// The content is passed through markdown renderer, so thinking tags
			// won't be in a collapsible section - they'll be rendered as-is through markdown
			// The key check is that no thinking-section details element exists
			expect(wrapper.container.textContent).toContain('Hello');
			expect(wrapper.container.textContent).toContain('World');
		});
	});
});

describe('parseThinkingSegments', () => {
	it('should return single text segment for content without thinking tags', () => {
		const result = parseThinkingSegments('Just plain text');
		expect(result).toEqual([{ type: 'text', content: 'Just plain text' }]);
	});

	it('should parse complete thinking tag into text and thinking segments', () => {
		const result = parseThinkingSegments('Before <thinking>The thought</thinking> After');
		expect(result).toEqual([
			{ type: 'text', content: 'Before ' },
			{ type: 'thinking', content: 'The thought' },
			{ type: 'text', content: ' After' },
		]);
	});

	it('should handle multiple thinking tags', () => {
		const result = parseThinkingSegments('A <thinking>T1</thinking> B <thinking>T2</thinking> C');
		expect(result).toEqual([
			{ type: 'text', content: 'A ' },
			{ type: 'thinking', content: 'T1' },
			{ type: 'text', content: ' B ' },
			{ type: 'thinking', content: 'T2' },
			{ type: 'text', content: ' C' },
		]);
	});

	it('should hide incomplete opening tag during streaming', () => {
		const result = parseThinkingSegments('Visible text <thinking>Incomplete thought...');
		expect(result).toEqual([{ type: 'text', content: 'Visible text ' }]);
	});

	it('should trim whitespace from thinking content', () => {
		const result = parseThinkingSegments('<thinking>  trimmed  </thinking>');
		expect(result).toEqual([{ type: 'thinking', content: 'trimmed' }]);
	});

	it('should handle thinking tag at the start', () => {
		const result = parseThinkingSegments('<thinking>Thought</thinking> After');
		expect(result).toEqual([
			{ type: 'thinking', content: 'Thought' },
			{ type: 'text', content: ' After' },
		]);
	});

	it('should handle thinking tag at the end', () => {
		const result = parseThinkingSegments('Before <thinking>Thought</thinking>');
		expect(result).toEqual([
			{ type: 'text', content: 'Before ' },
			{ type: 'thinking', content: 'Thought' },
		]);
	});

	it('should return empty array for empty string', () => {
		const result = parseThinkingSegments('');
		expect(result).toEqual([]);
	});

	it('should handle case-insensitive tags', () => {
		const result = parseThinkingSegments('<THINKING>Upper</THINKING>');
		expect(result).toEqual([{ type: 'thinking', content: 'Upper' }]);
	});

	it('should handle multiline thinking content', () => {
		const result = parseThinkingSegments('<thinking>Line 1\nLine 2\nLine 3</thinking>');
		expect(result).toEqual([{ type: 'thinking', content: 'Line 1\nLine 2\nLine 3' }]);
	});
});
