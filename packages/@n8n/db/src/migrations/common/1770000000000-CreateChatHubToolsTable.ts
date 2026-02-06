import { randomUUID } from 'node:crypto';

import type { ReversibleMigration, MigrationContext } from '../migration-types';

const table = {
	tools: 'chat_hub_tools',
	sessions: 'chat_hub_sessions',
	agents: 'chat_hub_agents',
	sessionTools: 'chat_hub_session_tools',
	agentTools: 'chat_hub_agent_tools',
	user: 'user',
} as const;

interface SessionRow {
	id: string;
	ownerId: string;
	tools: string;
}

interface AgentRow {
	id: string;
	ownerId: string;
	tools: string;
}

interface ToolDef {
	id: string;
	name: string;
	type: string;
	typeVersion: number;
}

export class CreateChatHubToolsTable1770000000000 implements ReversibleMigration {
	async up({
		schemaBuilder: { createTable, column, dropColumns },
		escape,
		runInBatches,
		runQuery,
		parseJson,
	}: MigrationContext) {
		// Create the chat_hub_tools table with type and typeVersion columns
		await createTable(table.tools)
			.withColumns(
				column('id').uuid.primary,
				column('name').varchar(255).notNull,
				column('type').varchar(255).notNull,
				column('typeVersion').int.notNull,
				column('ownerId').uuid.notNull,
				column('definition').json.notNull,
				column('enabled').bool.notNull.default(true),
			)
			.withForeignKey('ownerId', {
				tableName: table.user,
				columnName: 'id',
				onDelete: 'CASCADE',
			})
			.withIndexOn(['ownerId', 'name'], true).withTimestamps;

		// Create join tables
		await createTable(table.sessionTools)
			.withColumns(column('sessionId').uuid.notNull.primary, column('toolId').uuid.notNull.primary)
			.withForeignKey('sessionId', {
				tableName: table.sessions,
				columnName: 'id',
				onDelete: 'CASCADE',
			})
			.withForeignKey('toolId', {
				tableName: table.tools,
				columnName: 'id',
				onDelete: 'CASCADE',
			});

		await createTable(table.agentTools)
			.withColumns(column('agentId').uuid.notNull.primary, column('toolId').uuid.notNull.primary)
			.withForeignKey('agentId', {
				tableName: table.agents,
				columnName: 'id',
				onDelete: 'CASCADE',
			})
			.withForeignKey('toolId', {
				tableName: table.tools,
				columnName: 'id',
				onDelete: 'CASCADE',
			});

		// Data migration: move tools from sessions and agents to the join tables.
		// Before this migration tools were stored as full INode definitions in a JSON column on sessions and agents.
		// In practice we only supported three tools, but each session held unique copies of them.
		// Now we want to move them to the new chat_hub_tools table and reference them by ID from the join tables.
		// Build a per-user name -> tool ID map by deduplicating tools across sessions and agents
		const toolsByUserAndName = new Map<string, string>(); // key: `${ownerId}::${name}` -> toolId

		const sessionsTable = escape.tableName(table.sessions);
		const agentsTable = escape.tableName(table.agents);
		const toolsTable = escape.tableName(table.tools);
		const sessionToolsTable = escape.tableName(table.sessionTools);
		const agentToolsTable = escape.tableName(table.agentTools);

		// Helper to ensure a tool exists in chat_hub_tools and return its ID
		async function ensureTool(ownerId: string, def: ToolDef): Promise<string> {
			const key = `${ownerId}::${def.name}`;
			const existing = toolsByUserAndName.get(key);
			if (existing) return existing;

			const toolId = randomUUID();
			await runQuery(
				`INSERT INTO ${toolsTable} ("id", "name", "type", "typeVersion", "ownerId", "definition", "enabled")
				 VALUES (:id, :name, :type, :typeVersion, :ownerId, :definition, :enabled)`,
				{
					id: toolId,
					name: def.name,
					type: def.type,
					typeVersion: def.typeVersion,
					ownerId,
					definition: JSON.stringify({ ...def, id: toolId }),
					enabled: true,
				},
			);

			toolsByUserAndName.set(key, toolId);
			return toolId;
		}

		// Migrate sessions
		await runInBatches<SessionRow>(
			`SELECT "id", "ownerId", "tools" FROM ${sessionsTable} WHERE "tools" != '[]'`,
			async (sessions) => {
				for (const session of sessions) {
					const tools = parseJson<ToolDef[]>(session.tools);
					const insertedToolIds = new Set<string>();

					for (const tool of tools) {
						if (!tool.name || !tool.id) continue;

						const toolId = await ensureTool(session.ownerId, tool);
						if (insertedToolIds.has(toolId)) continue;
						insertedToolIds.add(toolId);

						await runQuery(
							`INSERT INTO ${sessionToolsTable} ("sessionId", "toolId") VALUES (:sessionId, :toolId)`,
							{ sessionId: session.id, toolId },
						);
					}
				}
			},
		);

		// Migrate agents
		await runInBatches<AgentRow>(
			`SELECT "id", "ownerId", "tools" FROM ${agentsTable} WHERE "tools" != '[]'`,
			async (agents) => {
				for (const agent of agents) {
					const tools = parseJson<ToolDef[]>(agent.tools);
					const insertedToolIds = new Set<string>();
					for (const tool of tools) {
						if (!tool.name || !tool.id) continue;

						const toolId = await ensureTool(agent.ownerId, tool);
						if (insertedToolIds.has(toolId)) continue;
						insertedToolIds.add(toolId);

						await runQuery(
							`INSERT INTO ${agentToolsTable} ("agentId", "toolId") VALUES (:agentId, :toolId)`,
							{ agentId: agent.id, toolId },
						);
					}
				}
			},
		);

		// Drop the tools columns from sessions and agents
		await dropColumns(table.sessions, ['tools']);
		await dropColumns(table.agents, ['tools']);
	}

	async down({ schemaBuilder: { addColumns, column, dropTable } }: MigrationContext) {
		await dropTable(table.sessionTools);
		await dropTable(table.agentTools);
		await dropTable(table.tools);

		await addColumns(table.sessions, [column('tools').json.notNull.default("'[]'")]);
		await addColumns(table.agents, [column('tools').json.notNull.default("'[]'")]);
	}
}
