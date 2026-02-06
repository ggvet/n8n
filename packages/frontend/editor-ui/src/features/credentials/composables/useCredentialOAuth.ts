import { useToast } from '@/app/composables/useToast';
import { useI18n } from '@n8n/i18n';
import { useCredentialsStore } from '../credentials.store';
import type { ICredentialsResponse } from '../credentials.types';

/**
 * Composable for OAuth credential type detection and authorization.
 * Shared between CredentialEdit and NodeCredentials.
 */
export function useCredentialOAuth() {
	const credentialsStore = useCredentialsStore();
	const toast = useToast();
	const i18n = useI18n();

	/**
	 * Get parent types for a credential type (e.g., googleSheetsOAuth2Api extends googleOAuth2Api extends oAuth2Api).
	 */
	function getParentTypes(
		credentialTypeName: string,
		visited = new Set<string>(),
	): string[] {
		if (visited.has(credentialTypeName)) return [];
		visited.add(credentialTypeName);

		const type = credentialsStore.getCredentialTypeByName(credentialTypeName);
		if (type?.extends === undefined) return [];

		const types: string[] = [];
		for (const typeName of type.extends) {
			types.push(typeName);
			types.push(...getParentTypes(typeName, visited));
		}
		return types;
	}

	/**
	 * Check if a credential type is an OAuth type (extends oAuth2Api or oAuth1Api).
	 */
	function isOAuthCredentialType(credentialTypeName: string): boolean {
		const parentTypes = getParentTypes(credentialTypeName);
		return (
			credentialTypeName === 'oAuth2Api' ||
			credentialTypeName === 'oAuth1Api' ||
			parentTypes.includes('oAuth2Api') ||
			parentTypes.includes('oAuth1Api')
		);
	}

	/**
	 * Check if a credential type is Google OAuth (extends googleOAuth2Api).
	 */
	function isGoogleOAuthType(credentialTypeName: string): boolean {
		const parentTypes = getParentTypes(credentialTypeName);
		return credentialTypeName === 'googleOAuth2Api' || parentTypes.includes('googleOAuth2Api');
	}

	/**
	 * Check if an OAuth credential type has all required fields managed/overwritten.
	 * This indicates the credential can be used with quick connect (just OAuth flow, no manual config).
	 * Reuses logic patterns from CredentialEdit.vue (credentialProperties + requiredPropertiesFilled).
	 */
	function hasManagedOAuthCredentials(credentialTypeName: string): boolean {
		if (!isOAuthCredentialType(credentialTypeName)) {
			return false;
		}

		const credentialType = credentialsStore.getCredentialTypeByName(credentialTypeName);
		if (!credentialType) {
			return false;
		}

		const overwrittenProperties = credentialType.__overwrittenProperties ?? [];
		if (overwrittenProperties.length === 0) {
			return false;
		}

		// Get required properties that would need user input (excluding notice and already overwritten)
		const requiredProperties = credentialType.properties.filter(
			(prop) => prop.required === true && prop.type !== 'notice',
		);

		// All required properties must be overwritten for managed credentials
		return requiredProperties.every((prop) => overwrittenProperties.includes(prop.name));
	}

	/**
	 * Authorize OAuth credentials by opening a popup and listening for callback.
	 * Returns true if OAuth was successful, false if cancelled or failed.
	 */
	async function authorize(credential: ICredentialsResponse): Promise<boolean> {
		const credentialTypeName = credential.type;
		const types = getParentTypes(credentialTypeName);

		let url: string | undefined;
		try {
			if (credentialTypeName === 'oAuth2Api' || types.includes('oAuth2Api')) {
				url = await credentialsStore.oAuth2Authorize(credential);
			} else if (credentialTypeName === 'oAuth1Api' || types.includes('oAuth1Api')) {
				url = await credentialsStore.oAuth1Authorize(credential);
			}
		} catch (error) {
			toast.showError(
				error,
				i18n.baseText('credentialEdit.credentialEdit.showError.generateAuthorizationUrl.title'),
			);
			return false;
		}

		if (!url) {
			toast.showError(
				new Error(i18n.baseText('credentialEdit.credentialEdit.showError.invalidOAuthUrl.message')),
				i18n.baseText('credentialEdit.credentialEdit.showError.invalidOAuthUrl.title'),
			);
			return false;
		}

		try {
			const parsedUrl = new URL(url);
			if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
				throw new Error('Invalid protocol');
			}
		} catch {
			toast.showError(
				new Error(i18n.baseText('credentialEdit.credentialEdit.showError.invalidOAuthUrl.message')),
				i18n.baseText('credentialEdit.credentialEdit.showError.invalidOAuthUrl.title'),
			);
			return false;
		}

		const params =
			'scrollbars=no,resizable=yes,status=no,titlebar=no,location=no,toolbar=no,menubar=no,width=500,height=700';
		const oauthPopup = window.open(url, 'OAuth Authorization', params);

		return await new Promise((resolve) => {
			const oauthChannel = new BroadcastChannel('oauth-callback');
			let settled = false;
			let pollTimer: ReturnType<typeof setInterval> | undefined;

			function cleanup() {
				if (pollTimer !== undefined) {
					clearInterval(pollTimer);
					pollTimer = undefined;
				}
				oauthChannel.close();
			}

			function settle(result: boolean) {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			}

			// Poll for popup being closed without completing OAuth (user clicked X)
			pollTimer = setInterval(() => {
				if (oauthPopup?.closed) {
					settle(false);
				}
			}, 500);

			oauthChannel.addEventListener('message', (event: MessageEvent) => {
				oauthPopup?.close();

				if (event.data === 'success') {
					toast.showMessage({
						title: i18n.baseText('credentialEdit.credentialEdit.showMessage.accountConnected'),
						type: 'success',
					});
					settle(true);
				} else {
					toast.showMessage({
						title: i18n.baseText(
							'credentialEdit.credentialEdit.showMessage.accountConnectionFailed',
						),
						type: 'error',
					});
					settle(false);
				}
			});
		});
	}

	return {
		getParentTypes,
		isOAuthCredentialType,
		isGoogleOAuthType,
		hasManagedOAuthCredentials,
		authorize,
	};
}
