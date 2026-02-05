import type { QuickConnectOption } from '@n8n/api-types';
import { computed } from 'vue';

import { useSettingsStore } from '@/app/stores/settings.store';
import { useCredentialsStore } from '../credentials.store';

/**
 * Composable for quick connect detection.
 * Used to determine when to show quick connect UI for credential types.
 */
export function useQuickConnect() {
	const settingsStore = useSettingsStore();
	const credentialsStore = useCredentialsStore();

	const quickConnectOptions = computed<QuickConnectOption[]>(
		() => settingsStore.moduleSettings['quick-connect']?.options ?? [],
	);

	/**
	 * Check if quick connect is configured for a credential type.
	 */
	function hasQuickConnect(credentialTypeName: string, nodeType?: string): boolean {
		return quickConnectOptions.value.some(
			(option) =>
				option.credentialType === credentialTypeName &&
				(nodeType === undefined || option.packageName === nodeType.split('.')[0]),
		);
	}

	/**
	 * Get the quick connect option for a credential type.
	 */
	function getQuickConnectOption(
		credentialTypeName: string,
		nodeType?: string,
	): QuickConnectOption | undefined {
		return quickConnectOptions.value.find(
			(option) =>
				option.credentialType === credentialTypeName &&
				(nodeType === undefined || option.packageName === nodeType.split('.')[0]),
		);
	}

	/**
	 * Get the sign-in button text for a credential type.
	 */
	function getSignInButtonText(credentialTypeName: string, nodeType?: string): string {
		const option = getQuickConnectOption(credentialTypeName, nodeType);
		if (option?.text) {
			return option.text;
		}

		const credentialType = credentialsStore.getCredentialTypeByName(credentialTypeName);
		const displayName = credentialType?.displayName ?? credentialTypeName;
		const cleanName = displayName.replace(/\s*(OAuth2?|API|Credentials?)\s*/gi, '').trim();

		return `Sign in with ${cleanName}`;
	}

	return {
		quickConnectOptions,
		hasQuickConnect,
		getQuickConnectOption,
		getSignInButtonText,
	};
}
