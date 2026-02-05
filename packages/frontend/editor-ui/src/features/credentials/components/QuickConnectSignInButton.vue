<script setup lang="ts">
import { N8nButton } from '@n8n/design-system';
import CredentialIcon from './CredentialIcon.vue';
import GoogleAuthButton from './CredentialEdit/GoogleAuthButton.vue';
import { useCredentialOAuth } from '../composables/useCredentialOAuth';

defineProps<{
	credentialTypeName: string;
	buttonText: string;
}>();

defineEmits<{
	click: [];
}>();

const { isGoogleOAuthType } = useCredentialOAuth();
</script>

<template>
	<GoogleAuthButton v-if="isGoogleOAuthType(credentialTypeName)" @click="$emit('click')" />
	<N8nButton
		v-else
		size="large"
		type="secondary"
		:class="$style.signInButton"
		@click="$emit('click')"
	>
		<CredentialIcon :credential-type-name="credentialTypeName" :size="20" />
		<span :class="$style.buttonText">{{ buttonText }}</span>
	</N8nButton>
</template>

<style lang="scss" module>
.signInButton {
	display: inline-flex;
	align-items: center;
	gap: var(--spacing--2xs);
}

.buttonText {
	margin-left: var(--spacing--3xs);
}
</style>
