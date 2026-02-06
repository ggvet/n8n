import { Service } from '@n8n/di';
import { DataSource, EntityManager, Repository } from '@n8n/typeorm';

import { ChatHubTool, type IChatHubTool } from './chat-hub-tool.entity';

@Service()
export class ChatHubToolRepository extends Repository<ChatHubTool> {
	constructor(dataSource: DataSource) {
		super(ChatHubTool, dataSource.manager);
	}

	async createTool(tool: Partial<IChatHubTool> & Pick<IChatHubTool, 'id'>, trx?: EntityManager) {
		const em = trx ?? this.manager;
		await em.insert(ChatHubTool, tool);
		return await em.findOneOrFail(ChatHubTool, {
			where: { id: tool.id },
		});
	}

	async updateTool(id: string, updates: Partial<IChatHubTool>, trx?: EntityManager) {
		const em = trx ?? this.manager;
		await em.update(ChatHubTool, { id }, updates);
		return await em.findOneOrFail(ChatHubTool, {
			where: { id },
		});
	}

	async deleteTool(id: string, trx?: EntityManager) {
		const em = trx ?? this.manager;
		return await em.delete(ChatHubTool, { id });
	}

	async getManyByUserId(userId: string) {
		return await this.find({
			where: { ownerId: userId },
			order: { createdAt: 'ASC' },
		});
	}

	async getEnabledByUserId(userId: string, trx?: EntityManager) {
		const em = trx ?? this.manager;
		return await em.find(ChatHubTool, {
			where: { ownerId: userId, enabled: true },
			order: { createdAt: 'ASC' },
		});
	}

	async getOneById(id: string, userId: string, trx?: EntityManager) {
		const em = trx ?? this.manager;
		return await em.findOne(ChatHubTool, {
			where: { id, ownerId: userId },
		});
	}

	async getByIds(ids: string[], userId: string, trx?: EntityManager) {
		const em = trx ?? this.manager;
		if (ids.length === 0) return [];
		return await em
			.createQueryBuilder(ChatHubTool, 'tool')
			.where('tool.id IN (:...ids)', { ids })
			.andWhere('tool.ownerId = :userId', { userId })
			.orderBy('tool.createdAt', 'ASC')
			.getMany();
	}

	async getToolsForSession(sessionId: string, trx?: EntityManager): Promise<ChatHubTool[]> {
		const em = trx ?? this.manager;
		return await em
			.createQueryBuilder(ChatHubTool, 'tool')
			.innerJoin('chat_hub_session_tools', 'st', 'st.toolId = tool.id')
			.where('st.sessionId = :sessionId', { sessionId })
			.orderBy('tool.createdAt', 'ASC')
			.getMany();
	}

	async getToolsForAgent(agentId: string, trx?: EntityManager): Promise<ChatHubTool[]> {
		const em = trx ?? this.manager;
		return await em
			.createQueryBuilder(ChatHubTool, 'tool')
			.innerJoin('chat_hub_agent_tools', 'at', 'at.toolId = tool.id')
			.where('at.agentId = :agentId', { agentId })
			.orderBy('tool.createdAt', 'ASC')
			.getMany();
	}

	async getToolIdsForSession(sessionId: string, trx?: EntityManager): Promise<string[]> {
		const em = trx ?? this.manager;
		const rows = await em
			.createQueryBuilder()
			.select('st.toolId', 'toolId')
			.from('chat_hub_session_tools', 'st')
			.where('st.sessionId = :sessionId', { sessionId })
			.getRawMany<{ toolId: string }>();
		return rows.map((r) => r.toolId);
	}

	async getToolIdsForAgent(agentId: string, trx?: EntityManager): Promise<string[]> {
		const em = trx ?? this.manager;
		const rows = await em
			.createQueryBuilder()
			.select('at.toolId', 'toolId')
			.from('chat_hub_agent_tools', 'at')
			.where('at.agentId = :agentId', { agentId })
			.getRawMany<{ toolId: string }>();
		return rows.map((r) => r.toolId);
	}

	async setSessionTools(sessionId: string, toolIds: string[], trx?: EntityManager): Promise<void> {
		const em = trx ?? this.manager;
		await em
			.createQueryBuilder()
			.delete()
			.from('chat_hub_session_tools')
			.where('sessionId = :sessionId', { sessionId })
			.execute();

		if (toolIds.length > 0) {
			await em
				.createQueryBuilder()
				.insert()
				.into('chat_hub_session_tools')
				.values(toolIds.map((toolId) => ({ sessionId, toolId })))
				.execute();
		}
	}

	async setAgentTools(agentId: string, toolIds: string[], trx?: EntityManager): Promise<void> {
		const em = trx ?? this.manager;
		await em
			.createQueryBuilder()
			.delete()
			.from('chat_hub_agent_tools')
			.where('agentId = :agentId', { agentId })
			.execute();

		if (toolIds.length > 0) {
			await em
				.createQueryBuilder()
				.insert()
				.into('chat_hub_agent_tools')
				.values(toolIds.map((toolId) => ({ agentId, toolId })))
				.execute();
		}
	}
}
