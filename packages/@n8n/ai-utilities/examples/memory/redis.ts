import { BaseChatHistory, WindowedChatMemory, type Message } from '../../src';

// =============================================================================
// Redis Types
// =============================================================================

export interface RedisConfig {
	host?: string;
	port?: number;
	password?: string;
	db?: number;
	keyPrefix?: string;
	ttlSeconds?: number;
}

export interface RedisConnection {
	get(key: string): Promise<string | null>;
	set(key: string, value: string, options?: { ex?: number }): Promise<void>;
	del(key: string): Promise<void>;
	quit(): Promise<void>;
}

// =============================================================================
// Redis Connection Factory
// =============================================================================

/**
 * Create a Redis connection.
 * In production, use a real Redis client like `ioredis` or `redis`.
 *
 * Example with ioredis:
 * ```typescript
 * import Redis from 'ioredis';
 *
 * export function createRedisConnection(config: RedisConfig): RedisConnection {
 *   const client = new Redis({
 *     host: config.host ?? 'localhost',
 *     port: config.port ?? 6379,
 *     password: config.password,
 *     db: config.db ?? 0,
 *   });
 *
 *   return {
 *     async get(key) { return client.get(key); },
 *     async set(key, value, options) {
 *       if (options?.ex) {
 *         await client.set(key, value, 'EX', options.ex);
 *       } else {
 *         await client.set(key, value);
 *       }
 *     },
 *     async del(key) { await client.del(key); },
 *     async quit() { await client.quit(); },
 *   };
 * }
 * ```
 */
export function createRedisConnection(_config: RedisConfig): RedisConnection {
	const storage = new Map<string, { value: string; expiresAt?: number }>();

	return {
		async get(key: string): Promise<string | null> {
			const entry = storage.get(key);
			if (!entry) return null;
			if (entry.expiresAt && Date.now() > entry.expiresAt) {
				storage.delete(key);
				return null;
			}
			return entry.value;
		},

		async set(key: string, value: string, options?: { ex?: number }): Promise<void> {
			const expiresAt = options?.ex ? Date.now() + options.ex * 1000 : undefined;
			storage.set(key, { value, expiresAt });
		},

		async del(key: string): Promise<void> {
			storage.delete(key);
		},

		async quit(): Promise<void> {
			storage.clear();
		},
	};
}

// =============================================================================
// Redis Chat History
// =============================================================================

export interface RedisChatHistoryConfig extends RedisConfig {
	sessionId: string;
}

export class RedisChatHistory extends BaseChatHistory {
	private readonly redis: RedisConnection;
	private readonly key: string;
	private readonly ttlSeconds?: number;

	constructor(redis: RedisConnection, config: RedisChatHistoryConfig) {
		super();
		this.redis = redis;
		this.ttlSeconds = config.ttlSeconds;

		const prefix = config.keyPrefix ?? 'n8n:chat:';
		this.key = `${prefix}${config.sessionId}`;
	}

	async getMessages(): Promise<Message[]> {
		const data = await this.redis.get(this.key);
		if (!data) return [];

		try {
			return JSON.parse(data) as Message[];
		} catch {
			return [];
		}
	}

	async addMessage(message: Message): Promise<void> {
		const messages = await this.getMessages();
		messages.push(message);
		await this.saveMessages(messages);
	}

	async addMessages(messages: Message[]): Promise<void> {
		const existing = await this.getMessages();
		existing.push(...messages);
		await this.saveMessages(existing);
	}

	async clear(): Promise<void> {
		await this.redis.del(this.key);
	}

	private async saveMessages(messages: Message[]): Promise<void> {
		const data = JSON.stringify(messages);
		await this.redis.set(this.key, data, this.ttlSeconds ? { ex: this.ttlSeconds } : undefined);
	}
}

// =============================================================================
// Redis Chat Memory (with windowing)
// =============================================================================

export interface RedisChatMemoryConfig extends RedisChatHistoryConfig {
	windowSize?: number;
}

export function createRedisChatMemory(
	redis: RedisConnection,
	config: RedisChatMemoryConfig,
): WindowedChatMemory {
	const history = new RedisChatHistory(redis, config);
	return new WindowedChatMemory(history, { windowSize: config.windowSize ?? 10 });
}

// =============================================================================
// Usage in n8n Community Node
// =============================================================================

/*
import type { ISupplyDataFunctions, SupplyData } from 'n8n-workflow';
import { supplyMemory } from '@n8n/ai-utilities';
import { createRedisConnection, createRedisChatMemory } from './redis';

export class MemoryRedis implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Redis Chat Memory',
    name: 'memoryRedis',
    // ... node configuration
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const host = this.getNodeParameter('host', itemIndex) as string;
    const port = this.getNodeParameter('port', itemIndex) as number;
    const sessionId = this.getNodeParameter('sessionId', itemIndex) as string;
    const windowSize = this.getNodeParameter('windowSize', itemIndex) as number;
    const ttlSeconds = this.getNodeParameter('ttlSeconds', itemIndex) as number;

    const redis = createRedisConnection({ host, port });

    const memory = createRedisChatMemory(redis, {
      sessionId,
      windowSize,
      ttlSeconds,
    });

    return supplyMemory(this, memory, {
      closeFunction: async () => {
        await redis.quit();
      },
    });
  }
}
*/
