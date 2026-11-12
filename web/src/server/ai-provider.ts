import "server-only";

import type { MapStepper } from "./ai-map-stream";

// 📖 Learn: TypeScript interfaces define a "contract" — the shape any
// implementing object must have. This file is the only place in the codebase
// that knows both providers exist; all callers just use the interface.
// This is the Strategy design pattern: swap implementations without changing callers.

export type ChatMessage = { role: "user" | "assistant"; content: string };

// A tool the model can "call" to output structured data.
// The model is forced to call it, so toolInput is always valid JSON matching the schema.
// 📖 Learn: this is the Strategy pattern for structured output — same shape works for
// both Anthropic tool use and Gemini function calling.
export interface ToolDefinition {
  name: string;
  description: string;
  // 📖 Learn: "inputSchema" is a JSON Schema object that describes the shape of the
  // tool's arguments. Both Anthropic and Gemini accept this same JSON Schema format.
  inputSchema: Record<string, unknown>;
}

// What streamMessageWithTool yields on each iteration — a discriminated union.
// The caller narrows with: if (chunk.type === "text") { ... } else { ... }
// 📖 Learn: discriminated unions let TypeScript know exactly which fields exist
// depending on the "type" tag, so you get autocomplete and type safety in each branch.
export type ToolStreamChunk =
  | { type: "text"; text: string }
  | { type: "tool"; input: Record<string, unknown> };

export interface AIProvider {
  // Creates a named assistant with a system prompt. Returns an opaque ID.
  createAssistant(name: string, systemPrompt?: string): Promise<string>;

  // Creates a conversation thread tied to an assistant. Returns an opaque ID.
  createThread(assistantId: string): Promise<string>;

  /**
   * Does this provider still hold both of these ids?
   *
   * Sessions live in PROCESS MEMORY, so they disappear on a server restart or
   * a request landing on a different serverless instance. Only the council
   * still uses sessions (created and used inside one request); the Ask AI map
   * chat is stateless and never touches them.
   */
  hasSession?(assistantId: string, threadId: string): boolean;

  // Streams a reply to `content` in the given thread. Yields text chunks.
  streamMessage(
    threadId: string,
    content: string,
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<string, void, unknown>;

  // Non-streaming version of streamMessage. Returns the full reply.
  sendMessage(
    threadId: string,
    content: string,
    model?: string,
    maxTokens?: number,
  ): Promise<string>;

  // Like streamMessage, but forces the model to call `tool` and emit structured JSON.
  // Yields text chunks while the model reasons, then a single { type: "tool" } chunk
  // at the end with the validated tool arguments.
  streamMessageWithTool(
    threadId: string,
    content: string,
    tool: ToolDefinition,
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<ToolStreamChunk, void, unknown>;

  // Optional READ-tool loop: the model may call any of `tools` zero or more times;
  // each call is executed via `runTool` and the result fed back. Yields text as it
  // reasons. Optional so providers without a tool-use loop (e.g. Gemini today) can
  // omit it and let callers fall back to injecting data into the prompt.
  streamMessageWithReadTools?(
    threadId: string,
    content: string,
    tools: ToolDefinition[],
    runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>,
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<string, void, unknown>;

  // Stateless call: pass a system prompt + full message history directly.
  // Used by docs-chat, /api/ai/message and the plain (non-map) /api/ai/chat.
  streamDirect(
    system: string,
    messages: ChatMessage[],
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<string, void, unknown>;

  /**
   * Ask AI map assistant: this provider's adapter for the ONE shared agent
   * loop in ai-map-stream.ts. A stepper makes a single model call at a time
   * and holds no conversation state — the browser sends the history with
   * every request. `tools` is the JSON-schema tool registry (MAP_TOOLS).
   */
  createMapStepper(options: { tools: ToolDefinition[] }): MapStepper;
}

export { DEFAULT_SYSTEM_PROMPT } from "./anthropic";

// ── Provider cache ────────────────────────────────────────────────────────────

/**
 * The council's in-memory assistants and threads for one provider. The maps
 * hold provider-specific records, so they're typed loosely here and each
 * provider file knows its own record shape.
 */
export interface ProviderSessionStores {
  assistants: Map<string, unknown>;
  threads: Map<string, unknown>;
}

type ProviderName = "anthropic" | "gemini";

/**
 * Session stores live on `globalThis`, not in this module.
 *
 * Why: in development, saving a server file makes Next.js re-run its modules
 * (hot reload), which used to replace the provider and its session maps — an
 * in-flight council run would then fail with "Unknown thread: <uuid>".
 * `globalThis` survives a hot reload, so the sessions do too.
 *
 * Why the STORES and not the provider objects themselves: a provider cached on
 * globalThis would keep running the OLD code after you edit anthropic.ts or
 * gemini.ts, until a full restart — very confusing. Providers are rebuilt from
 * fresh code; only the session data carries over.
 *
 * 📖 Learn: globalThis — the one object shared by every module in the process
 * (`window` in a browser, `global` in Node).
 */
function sessionStoresFor(name: ProviderName): ProviderSessionStores {
  const holder = globalThis as typeof globalThis & {
    __transitAiSessionStores?: Map<ProviderName, ProviderSessionStores>;
  };
  holder.__transitAiSessionStores ??= new Map();
  let stores = holder.__transitAiSessionStores.get(name);
  if (!stores) {
    stores = { assistants: new Map(), threads: new Map() };
    holder.__transitAiSessionStores.set(name, stores);
  }
  return stores;
}

// 📖 Learn: we cache one provider instance per name rather than a single
// global, so "anthropic" and "gemini" each keep their own SDK client.
const _providers = new Map<ProviderName, AIProvider>();

type ProviderFactory = (options?: { sessions?: ProviderSessionStores }) => AIProvider;

export function getProvider(name?: string): AIProvider {
  // A per-request "gemini" wins; anything else falls back to the env-var
  // default, then "anthropic". (Unchanged behaviour — note that this means an
  // explicit "anthropic" still gets Gemini when AI_PROVIDER=gemini.)
  const requested = name === "gemini" ? "gemini" : (process.env.AI_PROVIDER ?? "anthropic");
  const key: ProviderName = requested === "gemini" ? "gemini" : "anthropic";

  const cached = _providers.get(key);
  if (cached) return cached;

  let provider: AIProvider;
  if (key === "gemini") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createGeminiProvider } = require("./gemini") as { createGeminiProvider: ProviderFactory };
    provider = createGeminiProvider({ sessions: sessionStoresFor("gemini") });
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAnthropicProvider } = require("./anthropic") as { createAnthropicProvider: ProviderFactory };
    provider = createAnthropicProvider({ sessions: sessionStoresFor("anthropic") });
  }

  _providers.set(key, provider);
  return provider;
}
