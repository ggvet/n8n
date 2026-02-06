<script lang="ts" setup>
import { computed, nextTick, onMounted, watch } from 'vue';
import { useI18n } from '@n8n/i18n';
import { TEMPLATE_SETUP_EXPERIENCE } from '@/app/constants';
import { useNodeTypesStore } from '@/app/stores/nodeTypes.store';
import { useFocusPanelStore } from '@/app/stores/focusPanel.store';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { doesNodeHaveAllCredentialsFilled } from '@/app/utils/nodes/nodeTransforms';

import { N8nButton } from '@n8n/design-system';
import { usePostHog } from '@/app/stores/posthog.store';
import { injectWorkflowState } from '@/app/composables/useWorkflowState';
import { useReadyToRunStore } from '@/features/workflows/readyToRun/stores/readyToRun.store';
import { useRoute } from 'vue-router';

const workflowsStore = useWorkflowsStore();
const readyToRunStore = useReadyToRunStore();
const workflowState = injectWorkflowState();
const nodeTypesStore = useNodeTypesStore();
const posthogStore = usePostHog();
const focusPanelStore = useFocusPanelStore();
const i18n = useI18n();
const route = useRoute();

const isTemplateImportRoute = computed(() => {
	return route.query.templateId !== undefined;
});

const isTemplateSetupCompleted = computed(() => {
	return !!workflowsStore.workflow?.meta?.templateCredsSetupCompleted;
});

const allCredentialsFilled = computed(() => {
	if (isTemplateSetupCompleted.value) {
		return true;
	}

	const nodes = workflowsStore.getNodes();
	if (!nodes.length) {
		return true;
	}

	return nodes.every((node) => doesNodeHaveAllCredentialsFilled(nodeTypesStore, node));
});

const showButton = computed(() => {
	return !!workflowsStore.workflow?.meta?.templateId;
});

const isNewTemplatesSetupEnabled = computed(() => {
	return (
		posthogStore.getVariant(TEMPLATE_SETUP_EXPERIENCE.name) === TEMPLATE_SETUP_EXPERIENCE.variant
	);
});

const unsubscribe = watch(allCredentialsFilled, (newValue) => {
	if (newValue) {
		workflowState.addToWorkflowMetadata({
			templateCredsSetupCompleted: true,
		});

		unsubscribe();
	}
});

const openSetupPanel = () => {
	focusPanelStore.setSelectedTab('setup');
	focusPanelStore.openFocusPanel();
};

onMounted(async () => {
	// Wait for all reactive updates to settle before checking conditions
	// This ensures workflow.meta.templateId is available after initialization
	await nextTick();

	const templateId = workflowsStore.workflow?.meta?.templateId;
	const isReadyToRunWorkflow = readyToRunStore.isReadyToRunTemplateId(templateId);

	if (
		isNewTemplatesSetupEnabled.value &&
		showButton.value &&
		!isReadyToRunWorkflow &&
		isTemplateImportRoute.value
	) {
		openSetupPanel();
	}
});
</script>

<template>
	<N8nButton
		v-if="showButton"
		:label="i18n.baseText('nodeView.setupTemplate')"
		data-test-id="setup-credentials-button"
		size="large"
		icon="package-open"
		type="secondary"
		@click="openSetupPanel()"
	/>
</template>
