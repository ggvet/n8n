# Community Nodes for n8n

## Design Principles

### 1. Stable Interfaces, Hidden Implementation

Community nodes code against n8n-defined interfaces. Implementation details (LangChain, future alternatives) are encapsulated.

```typescript
// ✅ Community node imports
import { createChatModel, ChatModelOptions } from '@n8n/ai-node-sdk';

// ❌ Community node NEVER imports
import { ChatOpenAI } from '@langchain/openai';  // Forbidden
```

### 2. Peer Dependency with Runtime Injection

The new `@n8n/ai-node-sdk` package is declared as a **peer dependency** in community nodes. This follows the same proven pattern n8n already uses for `n8n-workflow`.

```json
{
  "peerDependencies": {
    "n8n-workflow": "*",
    "@n8n/ai-node-sdk": "*"
  }
}
```

#### How n8n's Peer Dependency Mechanism Works

This is a critical architectural detail. When n8n installs a community package, it **strips peer dependencies** before running `npm install`:

```typescript
// From packages/cli/src/modules/community-packages/community-packages.service.ts

// Strip dev, optional, and peer dependencies before running `npm install`
const {
  devDependencies,
  peerDependencies,      // ← REMOVED from package.json
  optionalDependencies,
  ...packageJson
} = JSON.parse(packageJsonContent);

await writeFile(packageJsonPath, JSON.stringify(packageJson, null, 2), 'utf-8');
await executeNpmCommand(['install', ...this.getNpmInstallArgs()], { cwd: packageDirectory });
```

#### Why This Pattern Works

| Concern | Solution |
|---------|----------|
| **Type safety during development** | npm installs SDK for types/autocomplete |
| **No duplicate packages at runtime** | n8n strips peer deps before install |
| **Version alignment guaranteed** | Runtime always uses n8n's bundled SDK |
| **LangChain hidden from community** | SDK's LangChain adapters use n8n's LC version |

#### Package Must Be Published to npm

`@n8n/ai-node-sdk` **must be published to npm** so that:

1. Community developers can `npm install` it during development
2. TypeScript can resolve types for `import { ... } from '@n8n/ai-node-sdk'`
3. IDE features (autocomplete, go-to-definition) work properly

However, the **published version is only used for development**. At runtime, n8n's bundled version is always used, ensuring perfect version alignment.

### 3. Minimal Surface Area

Inspired by Vercel AI SDK's approach: expose few, powerful primitives rather than many specific options.

| Component | Factory Function | Phase |
|-----------|------------------|-------|
| Chat Models | `createChatModel()` | Initial |
| Memory | `createMemory()` | Initial |
| Embeddings | `createEmbeddings()` | Future |
| Vector Stores | `createVectorStore()` | Future |
| Tools | `createTool()` | Future |

### 4. Composition Over Configuration

Use composable building blocks instead of monolithic configuration objects:

```typescript
// ✅ Composable
const memory = createMemory(this, {
  type: 'bufferWindow',
  chatHistory: new MyChatHistory({ connectionString }),
  k: 10,
});

// ❌ Monolithic
const memory = createMemory(this, {
  type: 'postgres',
  host: '...',
  port: 5432,
  database: '...',
  // 20 more connection options
});
```

### 5. Progressive Disclosure

Simple cases are simple. Complex cases are possible.

```typescript
// Simple: OpenAI-compatible model
const model = createChatModel(this, {
  type: 'openaiCompatible',
  apiKey: credentials.apiKey,
  baseUrl: 'https://api.example.com/v1',
  model: 'my-model',
});

// Complex: Fully custom model
const model = createChatModel(this, {
  type: 'custom',
  invoke: async (messages, options) => { /* ... */ },
  stream: async function* (messages, options) { /* ... */ },
});
```

---

## Proposed Architecture

### High-Level Design

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                               COMMUNITY NODE                                        │
│  ┌─────────────────────────────────────────────────────────────────────────────┐    │
│  │  import { createMemory, ChatHistory } from '@n8n/ai-node-sdk';              │    │
│  │                                                                             │    │
│  │  class MyMemory extends ChatHistory { /* provider-specific logic */ }       │    │
│  │                                                                             │    │
│  │  supplyData() {                                                             │    │
│  │    return { response: createMemory(this, { chatHistory: new MyMemory() }) };│    │
│  │  }                                                                          │    │
│  └─────────────────────────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │
                                        │ Uses as peer dependency
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                            @n8n/ai-node-sdk (NEW)                                   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │ EXPORTS (Public API - Stable Contract)                                       │   │
│  │                                                                              │   │
│  │ // Factory Functions                                                         │   │
│  │ export { createChatModel } from './factories/chatModel';                     │   │
│  │ export { createMemory } from './factories/memory';                           │   │
│  │                                                                              │   │
│  │ // Base Classes for Extension                                                │   │
│  │ export { ChatHistory } from './bases/chatHistory';                           │   │
│  │                                                                              │   │
│  │ // Types                                                                     │   │
│  │ export type { Message, ChatModelOptions, ... } from './types';               │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
│                                        │                                            │
│                                        │ Internal Implementation                    │
│                                        ▼                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │ ADAPTERS (Internal - Hidden from Community)                                  │   │
│  │                                                                              │   │
│  │ // Bridges n8n types ↔ LangChain types                                       │   │
│  │ class ChatHistoryAdapter extends BaseChatMessageHistory { }                  │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────┬─────────────────────────────────────────────┘
                                        │
                                        │ Returns LangChain objects
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────────────┐
│                               AI AGENT (Existing)                                   │
│  ┌──────────────────────────────────────────────────────────────────────────────┐   │
│  │  const memory = await getInputConnectionData(AiMemory);  // Gets LC object   │   │
│  │  const model = await getInputConnectionData(AiLanguageModel);                │   │
│  │                                                                              │   │
│  │  // Works exactly as before - no changes needed                              │   │
│  │  const agent = createToolsAgent({ model, memory, tools });                   │   │
│  └──────────────────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

### Package Structure

```
packages/
├── @n8n/ai-node-sdk/              # NEW: Published to npm
│   ├── src/
│   │   ├── index.ts               # Public exports only
│   │   ├── types/
│   │   │   ├── messages.ts        # Message, MessageRole
│   │   │   ├── chatModel.ts       # ChatModelOptions, etc.
│   │   │   └── memory.ts          # MemoryOptions
│   │   ├── bases/                 # Abstract classes for extension
│   │   │   └── chatHistory.ts     # ChatHistory
│   │   ├── factories/             # Factory functions
│   │   │   ├── chatModel.ts       # createChatModel()
│   │   │   └── memory.ts          # createMemory()
│   │   └── adapters/              # Internal LangChain adapters
│   │       └── chatHistoryAdapter.ts
│   ├── package.json
│   └── tsconfig.json
│
└── @n8n/nodes-langchain/          # EXISTING: Internal use
    └── ...                        # Unchanged
```

---

## API Design

### Core Types

#### Messages (LangChain-Agnostic)

```typescript
// types/messages.ts

export type MessageRole = 'human' | 'ai' | 'system' | 'function' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  additionalKwargs?: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AiMessage extends Message {
  role: 'ai';
  toolCalls?: ToolCall[];
}
```

#### Chat Model Options

```typescript
// types/chatModel.ts

export type ChatModelOptions =
  | OpenAICompatibleModelOptions
  | CustomChatModelOptions;

/**
 * For models implementing the OpenAI API spec.
 * Covers: OpenAI, Azure OpenAI, Ollama, LM Studio, vLLM, Together AI, etc.
 */
export interface OpenAICompatibleModelOptions {
  type: 'openaiCompatible';
  
  // Required
  apiKey: string;
  model: string;
  
  // Optional - defaults to OpenAI
  baseUrl?: string;
  
  // Common parameters
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  
  // Advanced
  timeout?: number;
  maxRetries?: number;
  headers?: Record<string, string>;
}

/**
 * For models with non-OpenAI APIs.
 * Only `invoke` is required. Streaming is optional.
 */
export interface CustomChatModelOptions {
  type: 'custom';
  
  // Model identifier
  name: string;
  
  // Required: core model logic
  invoke: (
    messages: Message[],
    options?: InvokeOptions
  ) => Promise<AiMessage>;
  
  // Optional: streaming support (for real-time token display in chat UI)
  stream?: (
    messages: Message[],
    options?: InvokeOptions
  ) => AsyncGenerator<StreamChunk>;
  
  // Optional: bind tools for function calling
  bindTools?: (tools: ToolDefinition[]) => CustomChatModelOptions;
}

export interface InvokeOptions {
  stop?: string[];
  signal?: AbortSignal;
}

export interface StreamChunk {
  content?: string;
  toolCalls?: Partial<ToolCall>[];
  finishReason?: 'stop' | 'tool_calls' | 'length';
}
```

#### Memory Options

```typescript
// types/memory.ts

export type MemoryOptions =
  | BufferMemoryOptions
  | BufferWindowMemoryOptions
  | TokenBufferMemoryOptions;

interface BaseMemoryOptions {
  chatHistory: ChatHistory;
  memoryKey?: string;       // Default: 'chat_history'
  inputKey?: string;        // Default: 'input'
  outputKey?: string;       // Default: 'output'
  returnMessages?: boolean; // Default: true
  humanPrefix?: string;     // Default: 'Human'
  aiPrefix?: string;        // Default: 'AI'
}

export interface BufferMemoryOptions extends BaseMemoryOptions {
  type: 'buffer';
}

export interface BufferWindowMemoryOptions extends BaseMemoryOptions {
  type: 'bufferWindow';
  k: number; // Number of recent messages to keep
}

export interface TokenBufferMemoryOptions extends BaseMemoryOptions {
  type: 'tokenBuffer';
  maxTokenLimit: number;
  model: ReturnType<typeof createChatModel>; // For token counting
}
```

#### Execution Context and Logging

All factory functions require the node execution context (`this` from `supplyData`) as the first parameter. The factory automatically wraps the returned object with n8n's `logWrapper`, enabling execution logging in the workflow UI.

```typescript
// Opaque return types - avoid exposing LangChain in the public API
// Internally these are LangChain objects, but the type hides this detail
type ChatModelInstance = unknown;
type MemoryInstance = unknown;

// Factory signatures - context first, then options
function createChatModel(
  context: ISupplyDataFunctions,
  options: ChatModelOptions
): ChatModelInstance;

function createMemory(
  context: ISupplyDataFunctions,
  options: MemoryOptions
): MemoryInstance;

// Usage in supplyData - same pattern for all factories
const memory = createMemory(this, {
  type: 'bufferWindow',
  chatHistory,
  k: 10,
});

const model = createChatModel(this, {
  type: 'openaiCompatible',
  apiKey,
  model: 'gpt-4',
});

return { response: memory };  // Already wrapped - no manual logWrapper needed
```

**Why require context and hide `logWrapper`?**

| Concern | Decision |
|---------|----------|
| Community devs shouldn't need to know internal logging details | Hide complexity |
| Forgetting to wrap breaks execution logging | Make context required |
| Consistent behavior across all community nodes | Factory handles it |
| `this` is always available in `supplyData` | No reason to make it optional |

#### Base Classes for Extension

```typescript
// bases/chatHistory.ts

/**
 * Base class for custom chat message storage.
 * Community nodes extend this to implement storage backends.
 */
export abstract class ChatHistory {
  /**
   * Unique namespace for this history implementation.
   * Used for serialization/deserialization.
   */
  abstract readonly namespace: string[];

  /**
   * Retrieve all messages from storage.
   */
  abstract getMessages(): Promise<Message[]>;

  /**
   * Add a single message to storage.
   */
  abstract addMessage(message: Message): Promise<void>;

  /**
   * Add multiple messages to storage.
   * Default implementation calls addMessage in sequence.
   */
  async addMessages(messages: Message[]): Promise<void> {
    for (const message of messages) {
      await this.addMessage(message);
    }
  }

  /**
   * Clear all messages from storage.
   */
  abstract clear(): Promise<void>;
}
```

---

## Code Examples

### Example 1: Memory Node with SDK (Internal)

This example shows how an **internal n8n node** would use the SDK. Internal nodes can use third-party packages like `ioredis`. Community nodes would need to use HTTP-based APIs (e.g., Upstash REST API) instead.

```typescript
// nodes/MemoryRedis/MemoryRedis.node.ts

import {
  NodeConnectionTypes,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
} from 'n8n-workflow';
import {
  createMemory,
  ChatHistory,
  type Message,
} from '@n8n/ai-node-sdk';
import Redis from 'ioredis';

// Step 1: Implement ChatHistory for Redis
class RedisChatHistory extends ChatHistory {
  readonly namespace = ['n8n', 'memory', 'redis'];
  
  private client: Redis;
  private sessionId: string;
  private ttl: number;

  constructor(options: { client: Redis; sessionId: string; ttl?: number }) {
    super();
    this.client = options.client;
    this.sessionId = options.sessionId;
    this.ttl = options.ttl ?? 3600; // 1 hour default
  }

  private get key(): string {
    return `n8n:chat:${this.sessionId}`;
  }

  async getMessages(): Promise<Message[]> {
    const data = await this.client.lrange(this.key, 0, -1);
    return data.map((item) => JSON.parse(item));
  }

  async addMessage(message: Message): Promise<void> {
    await this.client.rpush(this.key, JSON.stringify(message));
    await this.client.expire(this.key, this.ttl);
  }

  async clear(): Promise<void> {
    await this.client.del(this.key);
  }
}

// Step 2: Implement the n8n node
export class MemoryRedis implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Redis Memory',
    name: 'memoryRedis',
    group: ['transform'],
    version: 1,
    description: 'Store chat history in Redis',
    defaults: { name: 'Redis Memory' },
    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Memory'] },
    },
    inputs: [],
    outputs: [NodeConnectionTypes.AiMemory],
    outputNames: ['Memory'],
    credentials: [{ name: 'redis', required: true }],
    properties: [
      {
        displayName: 'Session ID',
        name: 'sessionId',
        type: 'string',
        default: '={{ $json.sessionId }}',
        required: true,
      },
      {
        displayName: 'Context Window',
        name: 'contextWindow',
        type: 'number',
        default: 10,
        description: 'Number of messages to keep in context',
      },
      {
        displayName: 'TTL (seconds)',
        name: 'ttl',
        type: 'number',
        default: 3600,
        description: 'Time-to-live for chat history',
      },
    ],
  };

  async supplyData(
    this: ISupplyDataFunctions,
    itemIndex: number
  ): Promise<SupplyData> {
    const credentials = await this.getCredentials('redis');
    const sessionId = this.getNodeParameter('sessionId', itemIndex) as string;
    const contextWindow = this.getNodeParameter('contextWindow', itemIndex) as number;
    const ttl = this.getNodeParameter('ttl', itemIndex) as number;

    // Create Redis client
    const client = new Redis({
      host: credentials.host as string,
      port: credentials.port as number,
      password: credentials.password as string,
    });

    // Create n8n chat history
    const chatHistory = new RedisChatHistory({ client, sessionId, ttl });

    // Use factory to create LangChain-compatible memory
    const memory = createMemory(this, {
      type: 'bufferWindow',
      chatHistory,
      k: contextWindow,
      returnMessages: true,
    });

    return {
      response: memory,  // Already wrapped with logWrapper
      closeFunction: async () => {
        await client.quit();
      },
    };
  }
}
```

### Example 2: Custom Chat Model (Community-Compatible)

This example shows creating a chat model for a custom API endpoint. Uses `this.helpers.httpRequest()` so it works for both internal and community nodes.

```typescript
// nodes/LmChatCustomProvider/LmChatCustomProvider.node.ts

import {
  NodeConnectionTypes,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
} from 'n8n-workflow';
import {
  createChatModel,
  type Message,
  type AiMessage,
  type StreamChunk,
} from '@n8n/ai-node-sdk';

export class LmChatCustomProvider implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Custom Provider Chat Model',
    name: 'lmChatCustomProvider',
    group: ['transform'],
    version: 1,
    description: 'Use custom AI provider',
    defaults: { name: 'Custom Provider' },
    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Language Models'] },
    },
    inputs: [],
    outputs: [NodeConnectionTypes.AiLanguageModel],
    outputNames: ['Model'],
    credentials: [{ name: 'customProviderApi', required: true }],
    properties: [
      {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default: 'custom-model-v1',
        required: true,
      },
      {
        displayName: 'Temperature',
        name: 'temperature',
        type: 'number',
        default: 0.7,
        typeOptions: { minValue: 0, maxValue: 2 },
      },
    ],
  };

  async supplyData(
    this: ISupplyDataFunctions,
    itemIndex: number
  ): Promise<SupplyData> {
    const credentials = await this.getCredentials('customProviderApi');
    const modelName = this.getNodeParameter('model', itemIndex) as string;
    const temperature = this.getNodeParameter('temperature', itemIndex) as number;

    const baseUrl = credentials.baseUrl as string;
    const apiKey = credentials.apiKey as string;

    // Option A: If OpenAI-compatible, use simple config
    if (credentials.isOpenAICompatible) {
      const model = createChatModel(this, {
        type: 'openaiCompatible',
        apiKey,
        baseUrl,
        model: modelName,
        temperature,
      });
      return { response: model };
    }

    // Option B: Custom API - implement invoke/stream
    const model = createChatModel(this, {
      type: 'custom',
      name: modelName,

      invoke: async (messages: Message[]): Promise<AiMessage> => {
        // Use n8n's httpRequest helper for better proxy/retry handling
        const data = await this.helpers.httpRequest({
          method: 'POST',
          url: `${baseUrl}/v1/chat`,
          headers: {
            'Authorization': `Bearer ${apiKey}`,
          },
          body: {
            model: modelName,
            messages: messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            temperature,
          },
        });
        
        return {
          role: 'ai',
          content: data.choices[0].message.content,
          toolCalls: data.choices[0].message.tool_calls?.map((tc: any) => ({
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
          })),
        };
      },

      // Optional: streaming support
      stream: async function* (messages: Message[]): AsyncGenerator<StreamChunk> {
        // TODO: Consider providing SDK helper like `createSSEStream(this, options)`
        // to abstract away low-level fetch/streaming complexity.
      },
    });

    return { response: model };
  }
}
```

---

## Migration Strategy

### Phase 1: Foundation

1. **Create `@n8n/ai-node-sdk` package**
   - Define all public types and interfaces
   - Implement `ChatHistory` base class (for memory nodes)
   - Create factory functions with LangChain adapters

2. **Migrate internal nodes as proof-of-concept**
   - `MemoryPostgres` → Use new SDK
   - `LmChatOpenAi` → Verify OpenAI-compatible path works
   - Validate no regressions

### Phase 2: Core Adapters

1. **Implement factory functions**
   - `createChatModel()` with OpenAI-compatible and custom paths
   - `createMemory()` with buffer, bufferWindow, tokenBuffer types

2. **Add comprehensive test coverage**
   - Unit tests for adapters
   - Integration tests with real LangChain objects
   - E2E tests with sample community nodes

### Phase 3: Documentation & Launch

1. **Developer documentation**
   - Getting started guide
   - API reference
   - Example nodes for each type

2. **Community guidelines**
   - Publishing requirements
   - Security review process
   - Versioning policy

### Phase 4: Gradual Internal Migration (Ongoing)

Optionally migrate existing n8n AI nodes to use the SDK internally, ensuring the same code path for both internal and community nodes.

---

## Backwards Compatibility

### For Existing Workflows

**Zero breaking changes.** The new SDK is additive:

- Existing nodes continue using direct LangChain imports
- AI Agent and chains receive the same LangChain objects
- `logWrapper()` is handled internally by factory functions (community devs don't need to know about it)
