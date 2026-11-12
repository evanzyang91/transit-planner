import "server-only";

import {
  GoogleGenerativeAI,
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
  GoogleGenerativeAIRequestInputError,
  GoogleGenerativeAIResponseError,
  FunctionCallingMode,
  type Content,
  type FunctionDeclarationSchema,
  type Part,
} from "@google/generative-ai";
import type { TranscriptBlock } from "~/lib/map-assistant-protocol";
import type { AIProvider, ChatMessage, ToolDefinition, ToolStreamChunk } from "./ai-provider";
import type {
  LoopMessage,
  MapErrorInfo,
  MapStepEvent,
  MapStepResult,
  MapStepStopReason,
  MapStepUsage,
  MapStepper,
} from "./ai-map-stream";

// 📖 Learn: Gemini and Anthropic both take "system prompt + message history",
// but the SDKs look different in three ways:
//   1. System prompt → passed as `systemInstruction` on the model, not in the message list
//   2. History roles → "model" instead of "assistant"
//   3. Message format → { role, parts: [{ text }] } instead of { role, content }

// Maps Claude model names to Gemini equivalents so council.ts needs no changes.
// 📖 Learn: this keeps the mapping in one place — if Gemini releases a better
// model, you only edit this function.
function mapModel(claudeOrGeminiModel: string): string {
  if (claudeOrGeminiModel.includes("haiku")) return "gemini-2.5-flash";
  if (claudeOrGeminiModel.includes("sonnet") || claudeOrGeminiModel.includes("opus")) return "gemini-2.5-pro";
  // If the caller already passes a Gemini model name, use it directly.
  if (claudeOrGeminiModel.startsWith("gemini-")) return claudeOrGeminiModel;
  return "gemini-2.5-flash";
}

// Gemini's functionResponse part requires `response` to be an OBJECT; wrap
// primitives/arrays defensively so a tool result can never break the protocol.
function asResponseObject(result: unknown): Record<string, unknown> {
  return typeof result === "object" && result !== null && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result };
}

function toFunctionDeclarations(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // Our inputSchema is already valid JSON Schema; cast past the SDK's
    // stricter enum-based type (same approach as streamMessageWithTool below).
    parameters: t.inputSchema as unknown as FunctionDeclarationSchema,
  }));
}

type StoredAssistant = { name: string; systemPrompt: string };
type StoredMessage  = { role: "user" | "assistant"; content: string };
type StoredThread   = { assistantId: string; messages: StoredMessage[] };

/** Where the council's sessions live (see sessionStoresFor in ai-provider.ts). */
export interface GeminiSessionStores {
  assistants: Map<string, StoredAssistant>;
  threads: Map<string, StoredThread>;
}

export function createGeminiProvider(options: { sessions?: GeminiSessionStores } = {}): AIProvider {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const assistantStore = options.sessions?.assistants ?? new Map<string, StoredAssistant>();
  const threadStore    = options.sessions?.threads ?? new Map<string, StoredThread>();

  function getAssistant(id: string): StoredAssistant {
    const a = assistantStore.get(id);
    if (!a) throw new Error(`Unknown assistant: ${id}`);
    return a;
  }

  function getThread(id: string): StoredThread {
    const t = threadStore.get(id);
    if (!t) throw new Error(`Unknown thread: ${id}`);
    return t;
  }

  // Converts our internal message format to what Gemini's chat history expects.
  // 📖 Learn: Gemini calls the assistant role "model", not "assistant".
  function toGeminiHistory(messages: StoredMessage[]) {
    return messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  }

  return {
    async createAssistant(name, systemPrompt) {
      const assistantId = crypto.randomUUID();
      assistantStore.set(assistantId, {
        name,
        systemPrompt: systemPrompt ?? "",
      });
      return assistantId;
    },

    hasSession(assistantId, threadId) {
      const thread = threadStore.get(threadId);
      return Boolean(thread) && assistantStore.has(assistantId);
    },

    async createThread(assistantId) {
      getAssistant(assistantId);
      const threadId = crypto.randomUUID();
      threadStore.set(threadId, { assistantId, messages: [] });
      return threadId;
    },

    async *streamMessage(threadId, content, model = "claude-haiku-4-5-20251001", maxTokens = 600) {
      const thread    = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      // 📖 Learn: unlike Anthropic, Gemini wants the system prompt on the model
      // object, not mixed into the message list. Then we give it prior messages
      // as "history" and the new message via sendMessageStream().
      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
      });

      const chat = geminiModel.startChat({
        history: toGeminiHistory(thread.messages),
      });

      const result = await chat.sendMessageStream(content);

      let full = "";
      try {
        for await (const chunk of result.stream) {
          const text = chunk.text();
          if (text) {
            full += text;
            yield text;
          }
        }
      } finally {
        if (full) {
          const nextMessages: StoredMessage[] = [
            ...thread.messages,
            { role: "user",      content },
            { role: "assistant", content: full },
          ];
          threadStore.set(threadId, { ...thread, messages: nextMessages });
        }
      }
    },

    // 📖 Learn: Gemini calls this "function calling" rather than "tool use", but
    // the idea is identical. Key differences from Anthropic:
    //   1. Functions are declared inside a `tools` array as `functionDeclarations`
    //   2. `toolConfig.functionCallingConfig.mode = "ANY"` forces a function call
    //   3. The function arguments don't stream — they're in result.response after the
    //      stream completes. Text tokens stream normally; we get the call at the end.
    async *streamMessageWithTool(threadId, content, tool: ToolDefinition, model = "claude-haiku-4-5-20251001", maxTokens = 900): AsyncGenerator<ToolStreamChunk> {
      const thread    = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
        // 📖 Learn: tools are declared as functionDeclarations inside the tools array.
        // The parameters field accepts the same JSON Schema format Anthropic uses.
        tools: [{ functionDeclarations: [{
          name: tool.name,
          description: tool.description,
          // 📖 Learn: Gemini's SDK has a strict FunctionDeclarationSchema type, but our
          // inputSchema is already the right JSON Schema shape — we cast through unknown
          // to satisfy TypeScript without rewriting the schema in Gemini's enum format.
          parameters: tool.inputSchema as unknown as FunctionDeclarationSchema,
        }]}],
        // FunctionCallingMode.ANY = model must call a function (same as Anthropic's tool_choice: "tool")
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.ANY } },
      });

      const chat = geminiModel.startChat({ history: toGeminiHistory(thread.messages) });
      const result = await chat.sendMessageStream(content);

      let fullText = "";
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) {
          fullText += text;
          yield { type: "text", text };
        }
      }

      // 📖 Learn: result.response is a Promise that resolves once the stream is fully
      // consumed. It holds the complete response including any function calls that the
      // model made. Unlike Anthropic, the args arrive all at once, not streamed.
      const response = await result.response;
      const calls = response.functionCalls();
      const call = calls?.find((fc) => fc.name === tool.name);

      if (fullText) {
        threadStore.set(threadId, {
          ...thread,
          messages: [...thread.messages, { role: "user", content }, { role: "assistant", content: fullText }],
        });
      }

      if (call?.args) {
        yield { type: "tool", input: call.args as Record<string, unknown> };
      }
    },

    // Multi-turn READ-tool loop — Gemini parity with the Anthropic provider,
    // so council grounding no longer silently skips on this provider.
    // 📖 Learn: Gemini's agentic loop differs from Anthropic's in mechanics but
    // not in shape: the ChatSession keeps history internally, function args
    // arrive whole (not streamed), and results go back as `functionResponse`
    // parts in the next sendMessage.
    async *streamMessageWithReadTools(threadId, content, tools, runTool, model = "claude-haiku-4-5-20251001", maxTokens = 900) {
      const MAX_TOOL_LOOPS = 5;
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
        tools: [{ functionDeclarations: toFunctionDeclarations(tools) }],
        // AUTO (not ANY): tools are optional here — the model researches as
        // much as it needs, then answers. Mirrors Anthropic's tool_choice auto.
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
      });

      const chat = geminiModel.startChat({ history: toGeminiHistory(thread.messages) });
      let fullText = "";
      // First turn sends the user content; subsequent turns send tool results.
      let nextParts: string | Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = content;

      try {
        for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
          const result = await chat.sendMessageStream(nextParts);
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
              fullText += text;
              yield text;
            }
          }

          const response = await result.response;
          const calls = response.functionCalls() ?? [];
          if (calls.length === 0) return; // done researching

          const responses: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = [];
          for (const call of calls) {
            let out: unknown;
            try {
              out = await runTool(call.name, (call.args ?? {}) as Record<string, unknown>);
            } catch (e) {
              out = { error: String(e) };
            }
            responses.push({ functionResponse: { name: call.name, response: asResponseObject(out) } });
          }
          nextParts = responses;
        }
      } finally {
        // Persist only the text — the tool exchange lives in the ChatSession,
        // which we don't keep; the model's own notes carry the retrieved facts
        // forward into its later turns (same trade-off as text-only storage above).
        if (fullText) {
          threadStore.set(threadId, {
            ...thread,
            messages: [...thread.messages, { role: "user", content }, { role: "assistant", content: fullText }],
          });
        }
      }
    },

    // Ask AI map assistant — stateless: the shared loop in ai-map-stream.ts
    // drives this stepper one model call at a time (same loop as Anthropic).
    createMapStepper({ tools }) {
      return createGeminiMapStepper(genAI, tools);
    },

    async sendMessage(threadId, content, model = "claude-haiku-4-5-20251001", maxTokens = 600) {
      const thread    = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
      });

      const chat   = geminiModel.startChat({ history: toGeminiHistory(thread.messages) });
      const result = await chat.sendMessage(content);
      const text   = result.response.text();

      const nextMessages: StoredMessage[] = [
        ...thread.messages,
        { role: "user",      content },
        { role: "assistant", content: text },
      ];
      threadStore.set(threadId, { ...thread, messages: nextMessages });
      return text;
    },

    async *streamDirect(system, messages: ChatMessage[], model = "claude-haiku-4-5-20251001", maxTokens = 1024) {
      // Split the message list: everything before the last message is history,
      // the last message is the new user turn to send.
      const history = messages.slice(0, -1);
      const last    = messages[messages.length - 1];
      if (!last) return;

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        systemInstruction: system,
        generationConfig: { maxOutputTokens: maxTokens },
      });

      const chat = geminiModel.startChat({
        history: history.map((m) => ({
          role:  m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        })),
      });

      const result = await chat.sendMessageStream(last.content);
      for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
      }
    },
  };
}

// ── Ask AI map assistant: the Gemini "stepper" ────────────────────────────────
//
// Same job as the Anthropic stepper in anthropic.ts: translate ONE model call
// between the shared loop's neutral format (ai-map-stream.ts) and Gemini.
// The loop — narration resets, captions, statuses, tracing — is shared, so
// both providers behave the same.

/** Unchanged by the rework: the model the map chat already used on Gemini. */
export const GEMINI_MAP_MODEL = "gemini-2.5-flash";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON-schema keywords Gemini's function declarations accept. Anything else
// (additionalProperties, oneOf, $schema, …) can make the API reject the whole
// request, so it is dropped — the tool still works, just with a looser schema.
const GEMINI_SCHEMA_KEYS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "items",
  "enum",
  "format",
  "nullable",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
]);

/** Our JSON schema → the subset Gemini understands (recursively). */
export function toGeminiSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: "string" };
  const out: Record<string, unknown> = {};
  let enumHint: string | null = null;

  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_SCHEMA_KEYS.has(key)) continue;

    if (key === "properties" && isRecord(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) properties[name] = toGeminiSchema(sub);
      out.properties = properties;
    } else if (key === "items") {
      out.items = toGeminiSchema(value);
    } else if (key === "type" && Array.isArray(value)) {
      // JSON schema allows ["string", "null"]; Gemini wants one type + nullable.
      const nonNull = value.filter((t) => t !== "null");
      out.type = nonNull[0] ?? "string";
      if (value.includes("null")) out.nullable = true;
    } else if (key === "enum" && Array.isArray(value) && !value.every((v) => typeof v === "string")) {
      // Gemini only accepts string enums; keep the allowed values as a hint instead.
      enumHint = `One of: ${value.map((v) => JSON.stringify(v)).join(", ")}.`;
    } else {
      out[key] = value;
    }
  }

  // Added after the loop so it can't be overwritten by a later "description" key.
  if (enumHint) {
    const description = typeof out.description === "string" ? out.description : "";
    out.description = description ? `${description} ${enumHint}` : enumHint;
  }
  return out;
}

function toGeminiFunctionDeclaration(tool: ToolDefinition) {
  const parameters = toGeminiSchema(tool.inputSchema);
  // Gemini rejects an OBJECT schema with no properties — a tool without
  // arguments simply has no `parameters`.
  const hasProperties = isRecord(parameters.properties) && Object.keys(parameters.properties).length > 0;
  return {
    name: tool.name,
    description: tool.description,
    // 📖 Learn: the SDK types this with its own enum-based schema type; our
    // schema already has the right shape, so we cast through unknown.
    ...(hasProperties ? { parameters: parameters as unknown as FunctionDeclarationSchema } : {}),
  };
}

/** A tool_result's JSON string → the OBJECT Gemini's functionResponse requires. */
function toFunctionResponse(content: string, isError: boolean): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (isRecord(parsed)) return parsed;
    return { result: parsed };
  } catch {
    // Truncated or plain text (e.g. an old result cut to HISTORY_LIMITS).
    return isError ? { error: content } : { result: content };
  }
}

/**
 * The loop's messages → Gemini `contents`.
 * 📖 Learn: Gemini's roles are "user", "model" (= assistant) and "function"
 * (tool results). Tool calls are `functionCall` parts and results are
 * `functionResponse` parts matched by tool NAME, so we remember which name
 * each tool_use id had. Neighbours with the same role are joined.
 */
export function toGeminiContents(messages: LoopMessage[]): Content[] {
  const toolNameById = new Map<string, string>();
  const contents: Content[] = [];

  const append = (role: "user" | "model" | "function", parts: Part[]) => {
    if (parts.length === 0) return;
    const previous = contents[contents.length - 1];
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts: [...parts] });
  };

  for (const message of messages) {
    if (message.role === "assistant") {
      const parts: Part[] = [];
      for (const block of message.blocks) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          toolNameById.set(block.id, block.name);
          parts.push({ functionCall: { name: block.name, args: block.input } });
        }
      }
      append("model", parts);
      continue;
    }

    const responses: Part[] = [];
    const texts: Part[] = [];
    for (const block of message.blocks) {
      if (block.type === "tool_result") {
        const name = toolNameById.get(block.tool_use_id);
        if (!name) continue; // no matching call — sanitized history never has one
        const response = toFunctionResponse(block.content, block.is_error === true);
        responses.push({ functionResponse: { name, response } });
      } else if (block.type === "text") {
        texts.push({ text: block.text });
      }
    }
    append("function", responses);
    append("user", texts);
  }
  return contents;
}

function newToolUseId(): string {
  // Gemini 2.5 doesn't give its calls ids, but the transcript needs one per
  // call. Letters, digits and "_" only, so the same history also works on Anthropic.
  return `gm_${crypto.randomUUID().replace(/-/g, "")}`;
}

const REFUSAL_FINISH_REASONS = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);

function toGeminiStopReason(
  finishReason: string | undefined,
  blocked: boolean,
  blocks: TranscriptBlock[],
): MapStepStopReason {
  if (blocked) return "refusal";
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  if (finishReason !== undefined && REFUSAL_FINISH_REASONS.has(finishReason)) return "refusal";
  if (blocks.some((b) => b.type === "tool_use")) return "tool_use";
  if (finishReason === undefined || finishReason === "STOP") return "end_turn";
  return "other";
}

/** A thrown Gemini SDK error → what the user is told (typed classes, most specific first). */
export function describeGeminiError(error: unknown): MapErrorInfo {
  if (error instanceof GoogleGenerativeAIAbortError) {
    return { message: "Stopped.", reason: "stopped", retryable: false };
  }
  if (error instanceof GoogleGenerativeAIFetchError) {
    const status = error.status ?? 0;
    if (status === 429) {
      return {
        message: "The AI service is busy right now — try again in a moment.",
        reason: "rate limited",
        retryable: true,
      };
    }
    if (status >= 500) {
      return {
        message: "The AI service had a temporary problem — try again.",
        reason: "service error",
        retryable: true,
      };
    }
    if (status === 401 || status === 403) {
      return {
        message: "The AI service rejected this server's API key.",
        reason: "API key rejected",
        retryable: false,
      };
    }
    return {
      message: `The AI service rejected the request (HTTP ${status}).`,
      reason: "request rejected",
      retryable: false,
    };
  }
  if (error instanceof GoogleGenerativeAIResponseError) {
    return {
      message: "The AI service sent back a reply that couldn't be read — try again.",
      reason: "unreadable reply",
      retryable: true,
    };
  }
  if (error instanceof GoogleGenerativeAIRequestInputError) {
    return {
      message: "The request to the AI service was malformed.",
      reason: "request rejected",
      retryable: false,
    };
  }
  if (error instanceof GoogleGenerativeAIError) {
    // The SDK wraps network failures ("fetch failed") in its base class.
    return {
      message: "Couldn't reach the AI service — check the connection and try again.",
      reason: "connection lost",
      retryable: true,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Unknown error",
    reason: "server error",
    retryable: false,
  };
}

/** One model call of the map assistant on Gemini, streamed (see MapStepper in ai-map-stream.ts). */
export function createGeminiMapStepper(genAI: GoogleGenerativeAI, tools: ToolDefinition[]): MapStepper {
  const functionDeclarations = tools.map(toGeminiFunctionDeclaration);

  return {
    provider: "gemini",
    model: GEMINI_MAP_MODEL,
    describeError: describeGeminiError,

    async *step(request): AsyncGenerator<MapStepEvent, MapStepResult, void> {
      const model = genAI.getGenerativeModel({
        model: GEMINI_MAP_MODEL,
        // Gemini has a single system instruction, so the two halves are joined.
        systemInstruction: [request.system.staticPrompt, request.system.dynamicContext]
          .filter((part) => part.trim() !== "")
          .join("\n\n"),
        tools: [{ functionDeclarations }],
        // AUTO = may call tools; NONE = must answer in words (the closing call).
        toolConfig: {
          functionCallingConfig: {
            mode: request.toolChoice === "none" ? FunctionCallingMode.NONE : FunctionCallingMode.AUTO,
          },
        },
        // Gemini 2.5 Flash also thinks, and thinking counts toward this cap.
        generationConfig: { maxOutputTokens: request.maxTokens },
      });

      // Stateless call: the whole conversation is sent each time (no ChatSession).
      const streamed = await model.generateContentStream(
        { contents: toGeminiContents(request.messages) },
        { signal: request.signal },
      );

      const blocks: TranscriptBlock[] = [];
      let finishReason: string | undefined;
      let blocked = false;
      let usage: MapStepUsage | undefined;

      // Parts are read straight off each chunk: the SDK's own aggregated
      // `response` merges parts in a lossy way.
      for await (const chunk of streamed.stream) {
        if (chunk.promptFeedback?.blockReason) blocked = true;
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) finishReason = candidate.finishReason;

        for (const part of candidate?.content?.parts ?? []) {
          // Thought summaries (only sent when asked for) are never shown.
          if ((part as { thought?: boolean }).thought === true) continue;

          if (typeof part.text === "string" && part.text !== "") {
            const last = blocks[blocks.length - 1];
            if (last?.type === "text") last.text += part.text;
            else blocks.push({ type: "text", text: part.text });
            yield { type: "text_delta", text: part.text };
          }
          if (part.functionCall) {
            const id = newToolUseId();
            const args = isRecord(part.functionCall.args) ? part.functionCall.args : {};
            blocks.push({ type: "tool_use", id, name: part.functionCall.name, input: args });
            // Gemini delivers a call whole, so "start" and "complete" coincide.
            yield { type: "tool_use_start", id, name: part.functionCall.name };
          }
        }

        if (chunk.usageMetadata) {
          const meta = chunk.usageMetadata as typeof chunk.usageMetadata & { thoughtsTokenCount?: number };
          const cached = meta.cachedContentTokenCount ?? 0;
          usage = {
            // Gemini's prompt count INCLUDES cached tokens; Anthropic's doesn't —
            // subtract so both providers report the same thing.
            inputTokens: Math.max(0, meta.promptTokenCount - cached),
            outputTokens: meta.candidatesTokenCount + (meta.thoughtsTokenCount ?? 0),
            cacheReadTokens: cached,
          };
        }
      }

      return { blocks, stopReason: toGeminiStopReason(finishReason, blocked, blocks), usage };
    },
  };
}
