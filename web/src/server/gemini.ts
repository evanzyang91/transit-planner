import "server-only";

import { GoogleGenerativeAI, FunctionCallingMode, type FunctionDeclarationSchema } from "@google/generative-ai";
import type { AIProvider, ChatMessage, MapToolStreamChunk, ToolDefinition, ToolStreamChunk } from "./ai-provider";
import { MAP_TOOLS, WRITE_TOOL_NAMES, runReadTool, resolveWriteTool } from "./map-data/tools";

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

export function createGeminiProvider(): AIProvider {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY environment variable is required");
  }

  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const assistantStore = new Map<string, StoredAssistant>();
  const threadStore    = new Map<string, StoredThread>();

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

    // Map-assistant loop — Gemini parity. READ tools execute server-side via
    // the shared registry; WRITE tools are resolved server-side (geometry
    // lookup / validation / road-snap) and forwarded to the client, with
    // rejections fed back so the model can self-correct. Mirrors
    // streamMapToolResponse in ai-map-stream.ts.
    async *streamMessageWithMapTools(threadId, content, ctx, model = "claude-haiku-4-5-20251001", maxTokens = 900): AsyncGenerator<MapToolStreamChunk> {
      const MAX_TOOL_LOOPS = 8;
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);

      const geminiModel = genAI.getGenerativeModel({
        model: mapModel(model),
        // The map prompt embeds live-network stats → per-request override wins.
        systemInstruction: ctx.systemPrompt ?? assistant.systemPrompt,
        generationConfig: { maxOutputTokens: maxTokens },
        tools: [{ functionDeclarations: toFunctionDeclarations(MAP_TOOLS) }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingMode.AUTO } },
      });

      const chat = geminiModel.startChat({ history: toGeminiHistory(thread.messages) });
      let fullText = "";
      let nextParts: string | Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = content;

      try {
        for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
          const result = await chat.sendMessageStream(nextParts);
          for await (const chunk of result.stream) {
            const text = chunk.text();
            if (text) {
              fullText += text;
              yield { type: "text", delta: text };
            }
          }

          const response = await result.response;
          const calls = response.functionCalls() ?? [];
          if (calls.length === 0) return;

          const responses: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = [];
          let anyRejected = false;
          let anyRead = false;

          for (const call of calls) {
            const args = (call.args ?? {}) as Record<string, unknown>;
            if (WRITE_TOOL_NAMES.has(call.name)) {
              const resolution = await resolveWriteTool(call.name, args, ctx);
              if (resolution.status === "rendered") {
                yield { type: "tool_call", name: resolution.clientName, args: resolution.clientArgs };
                responses.push({ functionResponse: { name: call.name, response: { status: "rendered_on_map" } } });
              } else {
                anyRejected = true;
                responses.push({ functionResponse: { name: call.name, response: { error: resolution.error } } });
              }
            } else {
              anyRead = true;
              let out: unknown;
              try {
                out = await runReadTool(call.name, args, ctx);
              } catch (e) {
                out = { error: String(e) };
              }
              responses.push({ functionResponse: { name: call.name, response: asResponseObject(out) } });
            }
          }

          // Pure-write turn where everything rendered → reply complete.
          if (!anyRead && !anyRejected) return;
          nextParts = responses;
        }
      } finally {
        if (fullText) {
          threadStore.set(threadId, {
            ...thread,
            messages: [...thread.messages, { role: "user", content }, { role: "assistant", content: fullText }],
          });
        }
      }
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
