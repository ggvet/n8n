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
	// List operations (atomic)
	rpush(key: string, ...values: string[]): Promise<number>;
	lrange(key: string, start: number, stop: number): Promise<string[]>;
	del(key: string): Promise<void>;
	expire(key: string, seconds: number): Promise<void>;
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
 *     async rpush(key, ...values) { return client.rpush(key, ...values); },
 *     async lrange(key, start, stop) { return client.lrange(key, start, stop); },
 *     async del(key) { await client.del(key); },
 *     async expire(key, seconds) { await client.expire(key, seconds); },
 *     async quit() { await client.quit(); },
 *   };
 * }
 * ```
 */
export function createRedisConnection(_config: RedisConfig): RedisConnection {
	const storage = new Map<string, { values: string[]; expiresAt?: number }>();

	return {
		async rpush(key: string, ...values: string[]): Promise<number> {
			let entry = storage.get(key);
			if (!entry || (entry.expiresAt && Date.now() > entry.expiresAt)) {
				entry = { values: [] };
				storage.set(key, entry);
			}
			entry.values.push(...values);
			return entry.values.length;
		},

		async lrange(key: string, start: number, stop: number): Promise<string[]> {
			const entry = storage.get(key);
			if (!entry) return [];
			if (entry.expiresAt && Date.now() > entry.expiresAt) {
				storage.delete(key);
				return [];
			}
			const end = stop === -1 ? entry.values.length : stop + 1;
			return entry.values.slice(start, end);
		},

		async del(key: string): Promise<void> {
			storage.delete(key);
		},

		async expire(key: string, seconds: number): Promise<void> {
			const entry = storage.get(key);
			if (entry) {
				entry.expiresAt = Date.now() + seconds * 1000;
			}
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

/**
 * Redis chat history using list operations for atomic appends.
 * Each message is stored as a separate list element, avoiding race conditions.
 */
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
		const items = await this.redis.lrange(this.key, 0, -1);
		return items
			.map((item) => {
				try {
					return JSON.parse(item) as Message;
				} catch {
					return null;
				}
			})
			.filter((m): m is Message => m !== null);
	}

	async addMessage(message: Message): Promise<void> {
		await this.redis.rpush(this.key, JSON.stringify(message));
		if (this.ttlSeconds) {
			await this.redis.expire(this.key, this.ttlSeconds);
		}
	}

	async addMessages(messages: Message[]): Promise<void> {
		if (messages.length === 0) return;
		const serialized = messages.map((m) => JSON.stringify(m));
		await this.redis.rpush(this.key, ...serialized);
		if (this.ttlSeconds) {
			await this.redis.expire(this.key, this.ttlSeconds);
		}
	}

	async clear(): Promise<void> {
		await this.redis.del(this.key);
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
