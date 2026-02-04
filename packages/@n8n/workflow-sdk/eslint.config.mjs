import { defineConfig, globalIgnores } from 'eslint/config';
import { nodeConfig } from '@n8n/eslint-config/node';

export default defineConfig(
	globalIgnores(['test-fixtures/**', 'scripts/**']),
	nodeConfig,
	{
		rules: {
			// Allow PascalCase for object property names (node names in tests/workflows)
			// TODO: Review and tighten naming conventions
			'@typescript-eslint/naming-convention': 'warn',
			// Disable this rule - it conflicts with legitimate use of literal ${} in strings
			// (e.g., testing code that contains template literals with ${$json.x})
			'n8n-local-rules/no-interpolation-in-regular-string': 'off',
			// These identifiers are used as object keys for type mappings
			'id-denylist': 'off',

			// TODO: Fix these issues incrementally
			'@typescript-eslint/no-unsafe-assignment': 'warn',
			'@typescript-eslint/no-unsafe-member-access': 'warn',
			'@typescript-eslint/no-unsafe-call': 'warn',
			'@typescript-eslint/no-unsafe-argument': 'warn',
			'@typescript-eslint/no-require-imports': 'warn',
			'@typescript-eslint/consistent-type-imports': 'warn',
			'@typescript-eslint/no-unnecessary-type-assertion': 'warn',
		},
	},
);
