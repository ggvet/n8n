<script setup lang="ts">
import { computed } from 'vue';

import { N8nActionDropdown, N8nButton, N8nIcon } from '@n8n/design-system';
import type { ActionDropdownItem } from '@n8n/design-system/types';
import { useI18n } from '@n8n/i18n';

type BuilderMode = 'build' | 'plan';

const props = defineProps<{
	modelValue: BuilderMode;
	disabled?: boolean;
}>();

const emit = defineEmits<{
	'update:modelValue': [value: BuilderMode];
}>();

const i18n = useI18n();

const modeOptions = computed<Array<ActionDropdownItem<BuilderMode>>>(() => [
	{
		id: 'build',
		label: i18n.baseText('aiAssistant.builder.planMode.selector.build'),
		icon: 'box',
	},
	{
		id: 'plan',
		label: i18n.baseText('aiAssistant.builder.planMode.selector.plan'),
		icon: 'list',
	},
]);

const currentMode = computed(() => {
	return modeOptions.value.find((opt) => opt.id === props.modelValue) ?? modeOptions.value[0];
});

function onSelect(value: BuilderMode) {
	emit('update:modelValue', value);
}
</script>

<template>
	<div :class="$style.container" data-test-id="plan-mode-selector">
		<N8nActionDropdown
			:items="modeOptions"
			:disabled="props.disabled"
			placement="top-start"
			hide-arrow
			@select="onSelect"
		>
			<template #activator>
				<N8nButton type="secondary" size="small" :disabled="props.disabled" :class="$style.trigger">
					<N8nIcon v-if="currentMode.icon" :icon="currentMode.icon" size="small" />
					<span :class="$style.label">{{ currentMode.label }}</span>
					<N8nIcon icon="chevron-down" size="xsmall" />
				</N8nButton>
			</template>
		</N8nActionDropdown>
	</div>
</template>

<style module lang="scss">
.container {
	display: flex;
	align-items: center;
}

.trigger {
	display: flex;
	align-items: center;
	gap: var(--spacing--4xs);
	padding: var(--spacing--2xs) var(--spacing--xs);
}
.label {
	font-size: var(--font-size--2xs);
}
</style>
