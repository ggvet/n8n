import { KafkaHelper } from 'n8n-containers/services/kafka';
import { LocalStackHelper } from 'n8n-containers/services/localstack';
import { MailpitHelper } from 'n8n-containers/services/mailpit';
import type { ServiceHelpers } from 'n8n-containers/services/types';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Capability } from '../fixtures/capabilities';

interface LocalServicesConfig {
	mailpit?: { apiBaseUrl: string; smtpHost: string; smtpPort: number };
	localstack?: { endpoint: string };
	kafka?: { broker: string };
}

/** Maps .services.json keys to capability names */
const SERVICE_TO_CAPABILITY: Record<string, Capability> = {
	mailpit: 'email',
	localstack: 'external-secrets',
	kafka: 'kafka',
};

const SERVICES_JSON_PATH = resolve(__dirname, '../.services.json');

/**
 * Reads .services.json written by `pnpm services` to get connection details
 * for locally-running service containers.
 */
function loadConfig(): LocalServicesConfig | null {
	if (!existsSync(SERVICES_JSON_PATH)) return null;
	try {
		return JSON.parse(readFileSync(SERVICES_JSON_PATH, 'utf-8')) as LocalServicesConfig;
	} catch {
		return null;
	}
}

/** Returns capability names that have local services available via .services.json */
export function getLocalCapabilities(): Capability[] {
	const config = loadConfig();
	if (!config) return [];

	return Object.entries(SERVICE_TO_CAPABILITY)
		.filter(([key]) => key in config)
		.map(([, cap]) => cap);
}

/**
 * Creates a ServiceHelpers proxy backed by .services.json for local mode.
 * Only services present in the JSON are available — accessing others throws.
 */
export function createLocalServiceHelpers(): ServiceHelpers | null {
	const config = loadConfig();
	if (!config) return null;

	const cache: Partial<ServiceHelpers> = {};

	return new Proxy({} as ServiceHelpers, {
		get: <K extends keyof ServiceHelpers>(_target: ServiceHelpers, prop: K): ServiceHelpers[K] => {
			if (prop in cache) return cache[prop]!;

			let helper: unknown;
			if (prop === 'mailpit' && config.mailpit) {
				helper = new MailpitHelper(
					config.mailpit.apiBaseUrl,
					config.mailpit.smtpHost,
					config.mailpit.smtpPort,
				);
			} else if (prop === 'localstack' && config.localstack) {
				helper = new LocalStackHelper(config.localstack.endpoint);
			} else if (prop === 'kafka' && config.kafka) {
				helper = new KafkaHelper(config.kafka.broker);
			}

			if (helper) {
				cache[prop] = helper as ServiceHelpers[K];
				return helper as ServiceHelpers[K];
			}

			throw new Error(
				`Service '${String(prop)}' not available in local mode. ` +
					`Start it with: pnpm --filter n8n-containers services --services ${String(prop)}`,
			);
		},
		has: (_target, prop) => {
			const key = String(prop);
			return key in config;
		},
	});
}
