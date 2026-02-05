import type { INodeProperties } from 'n8n-workflow';

import * as append from './append';
import * as chooseBranch from './chooseBranch';
import * as combineAll from './combineAll';
import * as combineByFields from './combineByFields';
import * as combineByPosition from './combineByPosition';
import * as combineBySql from './combineBySql';

export { append, chooseBranch, combineAll, combineByFields, combineBySql, combineByPosition };

export const description: INodeProperties[] = [
	{
		displayName: 'Mode',
		name: 'mode',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Append',
				value: 'append',
				description: 'Output items of each input, one after the other',
				builderHint: {
					message:
						'Do you need to collect items from multiple sources into a single list without modifying them? Use Append to concatenate items sequentially. Waits for all connected inputs. Supports any number of inputs. @example 2 items from Input A + 3 items from Input B → 5 items total',
				},
			},
			{
				name: 'Combine',
				value: 'combine',
				description: 'Merge matching items together',
				builderHint: {
					message:
						'Do you need to JOIN items from exactly 2 inputs based on matching field values (like linking user IDs to user details)? Use Combine for database-style JOINs. Only accepts 2 inputs. Waits for both. @example 2 users + 2 profiles matched by userId → 2 enriched user records (not 4)',
				},
			},
			{
				name: 'SQL Query',
				value: 'combineBySql',
				description: 'Write a query to do the merge',
				builderHint: {
					message:
						'Do you need complex merge logic using SQL syntax to filter, join, or transform data? Use SQL Query for advanced operations. Waits for all inputs. @example Results depend on query - can filter, join, aggregate',
				},
			},
			{
				name: 'Choose Branch',
				value: 'chooseBranch',
				description: 'Output data from a specific branch, without modifying it',
				builderHint: {
					message:
						'Do you need to select data from only ONE specific input and discard the others? Use Choose Branch after conditional nodes to pick which path to continue. Waits for all inputs. @example 3 items from Input A + 2 items from Input B, choose Input A → 3 items',
				},
			},
		],
		default: 'append',
		description: 'How input data should be merged',
	},
	{
		displayName: 'Combine By',
		name: 'combineBy',
		type: 'options',
		noDataExpression: true,
		options: [
			{
				name: 'Matching Fields',
				value: 'combineByFields',
				description: 'Combine items with the same field values',
			},
			{
				name: 'Position',
				value: 'combineByPosition',
				description: 'Combine items based on their order',
			},
			{
				name: 'All Possible Combinations',
				value: 'combineAll',
				description: 'Every pairing of every two items (cross join)',
			},
		],
		default: 'combineByFields',
		description: 'How input data should be merged',
		displayOptions: {
			show: { mode: ['combine'] },
		},
	},
	...append.description,
	...combineAll.description,
	...combineByFields.description,
	...combineBySql.description,
	...combineByPosition.description,
	...chooseBranch.description,
];
