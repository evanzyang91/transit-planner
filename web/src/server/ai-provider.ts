import "server-only";

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

export type MapToolStreamChunk =
  | { type: "text"; delta: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> };

export interface AIProvider {
  // Creates a named assistant with a system prompt. Returns an opaque ID.
  createAssistant(name: string, systemPrompt?: string): Promise<string>;

  // Creates a conversation thread tied to an assistant. Returns an opaque ID.
  createThread(assistantId: string): Promise<string>;

  /**
   * Does this provider still hold both of these ids?
   *
   * Sessions live in PROCESS MEMORY, so they disappear on a dev hot-reload, a
   * server restart, or a request landing on a different serverless instance —
   * while the browser keeps its ids in localStorage and sends them anyway.
   * Callers use this to start a fresh session instead of failing the request.
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

  /**
   * Map-assistant mode: multi-tool loop over the shared registry
   * (server/map-data/tools.ts). `ctx` carries the per-request grounding —
   * the user's live network and the artifact store that show_area resolves
   * against. Read tools execute server-side; write tools are validated /
   * geometry-resolved server-side and forwarded to the client.
   */
  // 📖 Learn: `import type` below is erased at compile time, so the circular
  // reference (tools.ts imports ToolDefinition from this file) is types-only
  // and safe — no runtime import cycle exists.
  streamMessageWithMapTools?(
    threadId: string,
    content: string,
    ctx: import("./map-data/tools").ToolContext,
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<MapToolStreamChunk, void, unknown>;

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
  // Used by docs-chat, which manages its own history client-side.
  streamDirect(
    system: string,
    messages: ChatMessage[],
    model?: string,
    maxTokens?: number,
  ): AsyncGenerator<string, void, unknown>;
}

export { DEFAULT_SYSTEM_PROMPT } from "./anthropic";

// 📖 Learn: we cache one provider instance per name rather than a single
// global, so "anthropic" and "gemini" can each keep their own in-memory
// assistant/thread stores alive for the lifetime of the server process.
const _providers = new Map<string, AIProvider>();

export function getProvider(name?: string): AIProvider {
  // Per-request name wins; fall back to the env-var default; then "anthropic".
  const key = name === "gemini" ? "gemini" : (process.env.AI_PROVIDER ?? "anthropic");

  const cached = _providers.get(key);
  if (cached) return cached;

  let provider: AIProvider;
  if (key === "gemini") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createGeminiProvider } = require("./gemini") as {
      createGeminiProvider: () => AIProvider;
    };
    provider = createGeminiProvider();
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createAnthropicProvider } = require("./anthropic") as {
      createAnthropicProvider: () => AIProvider;
    };
    provider = createAnthropicProvider();
  }

  _providers.set(key, provider);
  return provider;
}
