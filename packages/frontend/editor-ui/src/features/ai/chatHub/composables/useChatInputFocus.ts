import { shouldIgnoreCanvasShortcut } from '@/features/workflows/canvas/canvas.utils';
import { useUIStore } from '@/app/stores/ui.store';
import { useActiveElement, useEventListener } from '@vueuse/core';
import type { MaybeRefOrGetter, Ref } from 'vue';
import { computed, toValue } from 'vue';

interface ChatInputRef {
	focus: () => void;
	setText: (text: string) => void;
}

/**
 * Composable that enables "type-to-focus" behavior for the chat input.
 * When the user starts typing anywhere in the view (and isn't already
 * focused on an input), the chat input will be focused and the typed
 * character will be inserted.
 *
 * Guards:
 * - Skips if user is focused on input/textarea/contenteditable
 * - Skips if any modal is open
 * - Skips modifier key combinations (Ctrl/Cmd/Alt)
 * - Skips non-printable keys (arrows, escape, etc.)
 * - Skips during IME composition
 */
export function useChatInputFocus(
	inputRef: Ref<ChatInputRef | null | undefined>,
	options?: {
		disabled?: MaybeRefOrGetter<boolean>;
	},
) {
	const uiStore = useUIStore();
	const activeElement = useActiveElement();

	const isDisabled = computed(() => toValue(options?.disabled) ?? false);

	const shouldIgnoreKeypress = computed(() => {
		if (isDisabled.value) return true;
		if (uiStore.isAnyModalOpen) return true;
		if (activeElement.value && shouldIgnoreCanvasShortcut(activeElement.value)) return true;
		return false;
	});

	function isPrintableKey(event: KeyboardEvent): boolean {
		// Printable characters have a key length of 1
		// This excludes special keys like "Enter", "Escape", "ArrowUp", etc.
		return event.key.length === 1;
	}

	function hasModifierKey(event: KeyboardEvent): boolean {
		// Skip if any modifier key is pressed (except Shift, which is needed for uppercase/symbols)
		return event.ctrlKey || event.metaKey || event.altKey;
	}

	function onKeyDown(event: KeyboardEvent) {
		if (shouldIgnoreKeypress.value) return;
		if (event.isComposing) return;
		if (event.repeat) return;
		if (hasModifierKey(event)) return;
		if (!isPrintableKey(event)) return;

		const input = inputRef.value;
		if (!input) return;

		// Prevent the default behavior and handle it ourselves
		event.preventDefault();

		// Set the typed character and focus the input
		input.setText(event.key);
		input.focus();
	}

	useEventListener(document, 'keydown', onKeyDown);
}
