import "server-only";

import { startObservation } from "@langfuse/tracing";
import { tracingEnabled } from "./tracing";

import Anthropic from "@anthropic-ai/sdk";
import type { TranscriptBlock } from "~/lib/map-assistant-protocol";
import type {
  AIProvider,
  ChatMessage,
  ToolDefinition,
  ToolStreamChunk,
} from "./ai-provider";
import type {
  LoopMessage,
  MapErrorInfo,
  MapStepEvent,
  MapStepRequest,
  MapStepResult,
  MapStepStopReason,
  MapStepper,
} from "./ai-map-stream";

export const DEFAULT_SYSTEM_PROMPT = `You are a transit route planning assistant for Toronto.

You help urban planners design new transit lines. When the user describes a route requirement,
respond conversationally and helpfully. If they ask you to generate a specific route, also output
a JSON block at the end of your message in this exact format:

\`\`\`route
{
  "name": "Route Name",
  "type": "subway" | "streetcar" | "bus",
  "color": "#hexcolor",
  "stops": [
    { "name": "Stop Name", "coords": [-79.3832, 43.6532] }
  ]
}
\`\`\`

Coordinates are [longitude, latitude] in WGS84. Only include the JSON block when generating
an actual route. Use realistic Toronto coordinates. Keep stop names concise.`;

type StoredAssistant = {
  name: string;
  systemPrompt: string;
};

type StoredMessage = {
  role: "user" | "assistant";
  // Usually plain text, but the read-tool loop stores Anthropic content blocks
  // (tool_use / tool_result) so a planner remembers the data it retrieved across
  // turns. Widened to the union the Messages API already accepts for `messages`.
  content: string | Anthropic.Messages.ContentBlockParam[];
};

type StoredThread = {
  assistantId: string;
  messages: StoredMessage[];
};

/** Where the council's sessions live (see sessionStoresFor in ai-provider.ts). */
export interface AnthropicSessionStores {
  assistants: Map<string, StoredAssistant>;
  threads: Map<string, StoredThread>;
}

// 📖 Learn: a "factory function" creates and returns an object. The Maps
// (assistantStore, threadStore) are closed over. By default each call to
// createAnthropicProvider() gets its own private store; getProvider() passes
// in shared stores that survive a dev hot reload.
export function createAnthropicProvider(options: { sessions?: AnthropicSessionStores } = {}): AIProvider {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const assistantStore = options.sessions?.assistants ?? new Map<string, StoredAssistant>();
  const threadStore = options.sessions?.threads ?? new Map<string, StoredThread>();

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

  function extractText(content: Anthropic.Messages.Message["content"]): string {
    return content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");
  }

  return {
    async createAssistant(name, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
      const assistantId = crypto.randomUUID();
      assistantStore.set(assistantId, { name, systemPrompt });
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
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);
      const nextMessages: StoredMessage[] = [
        ...thread.messages,
        { role: "user", content },
      ];

      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: assistant.systemPrompt,
        messages: nextMessages,
      });

      let full = "";
      try {
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            full += event.delta.text;
            yield event.delta.text;
          }
        }
      } finally {
        if (full) {
          threadStore.set(threadId, {
            ...thread,
            messages: [...nextMessages, { role: "assistant", content: full }],
          });
        }
      }
    },

    // 📖 Learn: "tool_choice: { type: 'tool', name: '...' }" tells Claude it MUST call
    // that specific tool. The model can still write text first (its reasoning), then
    // calls the tool. We stream both: text chunks come as text_delta events; the tool
    // arguments arrive as input_json_delta fragments that we reassemble into JSON.
    async *streamMessageWithTool(threadId, content, tool: ToolDefinition, model = "claude-haiku-4-5-20251001", maxTokens = 900): AsyncGenerator<ToolStreamChunk> {
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);
      const nextMessages: StoredMessage[] = [
        ...thread.messages,
        { role: "user", content },
      ];

      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system: assistant.systemPrompt,
        messages: nextMessages,
        tools: [{
          name: tool.name,
          description: tool.description,
          // 📖 Learn: Anthropic names this field "input_schema" (snake_case)
          // even though we store it as "inputSchema" in our shared ToolDefinition.
          input_schema: tool.inputSchema as Anthropic.Messages.Tool["input_schema"],
        }],
        // Force Claude to call exactly this tool (not just "maybe use a tool")
        tool_choice: { type: "tool", name: tool.name },
      });

      let fullText = "";
      let toolInputJson = "";

      try {
        for await (const event of stream) {
          if (event.type === "content_block_delta") {
            if (event.delta.type === "text_delta") {
              fullText += event.delta.text;
              yield { type: "text", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              // 📖 Learn: the tool JSON is streamed as fragments (e.g. '{"name"' then
              // ':"Eglinton"' then ',"stops":[' ...). We accumulate and parse at the end.
              toolInputJson += event.delta.partial_json;
            }
          }
        }
      } finally {
        // Store only the text portion — agents run once per council, so we don't need
        // the tool call in history for multi-turn continuity.
        if (fullText) {
          threadStore.set(threadId, {
            ...thread,
            messages: [...nextMessages, { role: "assistant", content: fullText }],
          });
        }
      }

      if (toolInputJson) {
        try {
          yield { type: "tool", input: JSON.parse(toolInputJson) as Record<string, unknown> };
        } catch {
          // Malformed JSON from the model — caller will treat route as null
        }
      }
    },

    // Multi-turn READ-tool loop: the model may call any of `tools` zero or more
    // times; each call is executed server-side via `runTool` and the result fed
    // back so the model can keep reasoning. Yields the model's text as it goes.
    // 📖 Learn: this differs from streamMessageWithTool (which *forces* one tool
    // call and extracts its args without executing it). Here tools are optional
    // and actually run — the classic agentic tool-use loop.
    async *streamMessageWithReadTools(threadId, content, tools, runTool, model = "claude-haiku-4-5-20251001", maxTokens = 900) {
      const MAX_TOOL_LOOPS = 5;
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);
      const anthropicTools: Anthropic.Messages.Tool[] = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema as Anthropic.Messages.Tool["input_schema"],
      }));

      let messages: StoredMessage[] = [...thread.messages, { role: "user", content }];

      // Langfuse trace root. Typed "agent" (not a generic span) because this is
      // an autonomous tool-using loop — that type is what drives Langfuse's
      // Agent Graph view. Children are created off this handle rather than via
      // active context: an async generator yields across await boundaries, so
      // OTel's ambient context can't be relied on to still be current.
      const turn = tracingEnabled
        ? startObservation("map-assistant-turn", { input: content }, { asType: "agent" })
        : null;

      let answer = "";
      try {
        for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
          const generation = turn?.startObservation(
            `llm-call-${loop + 1}`,
            {
              model,
              input: messages,
              modelParameters: { max_tokens: maxTokens },
            },
            { asType: "generation" },
          );

          const stream = client.messages.stream({
            model,
            max_tokens: maxTokens,
            system: assistant.systemPrompt,
            messages,
            tools: anthropicTools,
            tool_choice: { type: "auto" },
          });

          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              answer += event.delta.text;
              yield event.delta.text;
            }
          }

          const final = await stream.finalMessage();

          // usageDetails is what lets Langfuse compute cost automatically.
          generation?.update({
            output: final.content,
            usageDetails: {
              input: final.usage.input_tokens,
              output: final.usage.output_tokens,
            },
          }).end();

          const toolUses = final.content.filter(
            (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
          );

          // No tool call this turn → the model is done researching. Persist the
          // full history (including any prior tool_use/tool_result pairs) so the
          // follow-up propose_route turn still "remembers" the retrieved data.
          if (toolUses.length === 0) {
            messages = [...messages, { role: "assistant", content: final.content }];
            threadStore.set(threadId, { ...thread, messages });
            return;
          }

          const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];
          for (const tu of toolUses) {
            // One "tool" observation per call — this is the "thought process":
            // exactly which tool ran, with what arguments, and what came back.
            const toolSpan = turn?.startObservation(
              tu.name,
              { input: tu.input },
              { asType: "tool" },
            );
            let resultJson: string;
            try {
              const result = await runTool(tu.name, tu.input as Record<string, unknown>);
              resultJson = JSON.stringify(result);
              toolSpan?.update({ output: result }).end();
            } catch (e) {
              resultJson = JSON.stringify({ error: String(e) });
              toolSpan?.update({ output: { error: String(e) }, level: "ERROR" }).end();
            }
            toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultJson });
          }

          messages = [
            ...messages,
            { role: "assistant", content: final.content },
            { role: "user", content: toolResults },
          ];
        }

        // Hit the loop cap — persist what we have so context isn't lost.
        threadStore.set(threadId, { ...thread, messages });
      } finally {
        // finally, not a tail call: a generator abandoned by its consumer (the
        // client disconnects mid-stream) resumes here via .return(), and an
        // unended span is never exported at all.
        turn?.update({ output: answer }).end();
      }
    },

    async sendMessage(threadId, content, model = "claude-haiku-4-5-20251001", maxTokens = 600) {
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);
      const nextMessages: StoredMessage[] = [
        ...thread.messages,
        { role: "user", content },
      ];

      const response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: assistant.systemPrompt,
        messages: nextMessages,
      });

      const text = extractText(response.content);
      threadStore.set(threadId, {
        ...thread,
        messages: [...nextMessages, { role: "assistant", content: text }],
      });
      return text;
    },

    // Ask AI map assistant — stateless: the shared loop in ai-map-stream.ts
    // drives this stepper one model call at a time.
    createMapStepper({ tools }) {
      return createAnthropicMapStepper(client, tools);
    },

    async *streamDirect(system, messages: ChatMessage[], model = "claude-haiku-4-5-20251001", maxTokens = 1024) {
      // 📖 Learn: we pass the full message list directly (no assistant/thread lookup)
      // so the caller controls history. Anthropic accepts this format natively.
      const stream = client.messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        messages,
      });

      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          yield event.delta.text;
        }
      }
    },
  };
}

// ── Ask AI map assistant: the Anthropic "stepper" ─────────────────────────────
//
// The agent loop itself lives in ai-map-stream.ts and is shared with Gemini.
// Everything below only translates ONE model call between the loop's neutral
// format and the Anthropic Messages API.

/** User decision (2026-11): Claude Haiku 5.5 at low effort — fast and cheap, with adaptive thinking. */
export const DEFAULT_MAP_MODEL = "claude-haiku-5-5";

type MapEffort = NonNullable<Anthropic.Messages.OutputConfig["effort"]>;
const DEFAULT_MAP_EFFORT: MapEffort = "low";
const EFFORT_LEVELS: readonly MapEffort[] = ["low", "medium", "high", "xhigh", "max"];

export interface AnthropicMapSettings {
  model: string;
  /** null = don't send `output_config.effort` (older models such as Haiku 4.5 reject it). */
  effort: MapEffort | null;
}

/**
 * MAP_ASSISTANT_MODEL / MAP_ASSISTANT_EFFORT let you try other settings (e.g.
 * in the benchmark) without a code change. MAP_ASSISTANT_EFFORT=none leaves
 * effort out entirely.
 */
export function mapSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): AnthropicMapSettings {
  const model = env.MAP_ASSISTANT_MODEL?.trim() ?? "";
  const rawEffort = env.MAP_ASSISTANT_EFFORT?.trim().toLowerCase() ?? "";

  let effort: MapEffort | null = DEFAULT_MAP_EFFORT;
  if (rawEffort === "none" || rawEffort === "off") {
    effort = null;
  } else if ((EFFORT_LEVELS as readonly string[]).includes(rawEffort)) {
    effort = rawEffort as MapEffort;
  } else if (rawEffort !== "") {
    console.warn(`[map-assistant] ignoring MAP_ASSISTANT_EFFORT="${rawEffort}", using "${DEFAULT_MAP_EFFORT}"`);
  }
  return { model: model || DEFAULT_MAP_MODEL, effort };
}

/** Our JSON-schema tool registry → Anthropic tool definitions (same order, so the cached prefix is stable). */
export function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Messages.Tool[] {
  // eager_input_streaming is left off on purpose: our tool arguments are tiny,
  // and with it on the API stops validating them, so we'd have to.
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    // 📖 Learn: Anthropic names this field "input_schema" (snake_case).
    input_schema: t.inputSchema as Anthropic.Messages.Tool["input_schema"],
  }));
}

function toAnthropicBlock(block: TranscriptBlock): Anthropic.Messages.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return block.is_error
        ? { type: "tool_result", tool_use_id: block.tool_use_id, content: block.content, is_error: true }
        : { type: "tool_result", tool_use_id: block.tool_use_id, content: block.content };
  }
}

/**
 * The loop's messages → Anthropic `messages`.
 *  • An assistant message from earlier in THIS turn is sent back exactly as
 *    the API returned it (`native`), thinking blocks included — the API
 *    requires them, unmodified, while a tool loop is in progress.
 *  • Everything else is rebuilt from the neutral blocks (history from the
 *    browser never contains thinking).
 *  • Neighbours with the same role are joined into one message (tool results
 *    first, then the user's new text), which is what the API expects after a
 *    turn that ended on tool results.
 */
export function toAnthropicMessages(messages: LoopMessage[]): Anthropic.Messages.MessageParam[] {
  const out: Array<{ role: "user" | "assistant"; content: Anthropic.Messages.ContentBlockParam[] }> = [];
  for (const message of messages) {
    const content =
      message.native?.provider === "anthropic"
        ? (message.native.content as Anthropic.Messages.ContentBlockParam[])
        : message.blocks.map(toAnthropicBlock);
    if (content.length === 0) continue;

    const previous = out[out.length - 1];
    if (previous?.role === message.role) {
      previous.content = [...previous.content, ...content];
    } else {
      out.push({ role: message.role, content: [...content] });
    }
  }
  return out;
}

/**
 * The full request for one step. Caching layout (≤ 4 breakpoints allowed, 2 used):
 *  1. `system[0]` = the static prompt, marked cache_control → the tool list +
 *     static prompt are cached across ALL requests (render order is tools →
 *     system → messages, and both are byte-identical every time);
 *  2. top-level cache_control → the API caches up to the last block, so step 2
 *     of a turn re-reads step 1's whole prompt from cache.
 * The per-request context goes in `system[1]`, after the first breakpoint.
 * `thinking` is deliberately not sent: Haiku 5.5 then runs adaptive thinking
 * (its default), and older models simply run without it.
 */
export function buildAnthropicMapParams(
  settings: AnthropicMapSettings,
  tools: Anthropic.Messages.Tool[],
  request: MapStepRequest,
): Anthropic.Messages.MessageStreamParams {
  const system: Anthropic.Messages.TextBlockParam[] = [
    { type: "text", text: request.system.staticPrompt, cache_control: { type: "ephemeral" } },
  ];
  // The API rejects empty text blocks.
  if (request.system.dynamicContext.trim() !== "") {
    system.push({ type: "text", text: request.system.dynamicContext });
  }

  return {
    model: settings.model,
    max_tokens: request.maxTokens,
    system,
    messages: toAnthropicMessages(request.messages),
    tools,
    // "auto" (not a forced tool): a forced tool_choice makes Haiku 5.5 skip thinking.
    tool_choice: { type: request.toolChoice },
    // 📖 Learn: prompt caching — the API stores the processed prompt prefix for
    // ~5 minutes; a later request with the same prefix reads it back at ~10% of
    // the price and with a faster first token.
    cache_control: { type: "ephemeral" },
    ...(settings.effort ? { output_config: { effort: settings.effort } } : {}),
  };
}

function toStopReason(reason: Anthropic.Messages.StopReason | null): MapStepStopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** The reply's text and tool calls, read BY TYPE (a reply may start with thinking blocks). */
function toNeutralBlocks(content: Anthropic.Messages.ContentBlock[]): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [];
  for (const block of content) {
    if (block.type === "text" && block.text !== "") {
      blocks.push({ type: "text", text: block.text });
    } else if (block.type === "tool_use") {
      const input = block.input;
      const isPlainObject = typeof input === "object" && input !== null && !Array.isArray(input);
      const args = isPlainObject ? (input as Record<string, unknown>) : {};
      blocks.push({ type: "tool_use", id: block.id, name: block.name, input: args });
    }
    // thinking / redacted_thinking stay only in `native` (sent back within this turn, never stored).
  }
  return blocks;
}

/** The message inside an API error body, e.g. "prompt is too long". */
function apiErrorDetail(error: { error: unknown; message: string }): string {
  const body = error.error as { error?: { message?: unknown } } | undefined;
  const detail = body?.error?.message;
  return typeof detail === "string" && detail !== "" ? detail : error.message;
}

/**
 * A thrown SDK error → what the user is told. Uses the SDK's typed error
 * classes (never matching on message text). Most specific first: several of
 * these classes extend each other.
 */
export function describeAnthropicError(error: unknown): MapErrorInfo {
  if (error instanceof Anthropic.APIUserAbortError) {
    return { message: "Stopped.", reason: "stopped", retryable: false };
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return {
      message: "The AI service took too long to answer — try again.",
      reason: "timed out",
      retryable: true,
    };
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return {
      message: "Couldn't reach the AI service — check the connection and try again.",
      reason: "connection lost",
      retryable: true,
    };
  }
  if (error instanceof Anthropic.RateLimitError) {
    return {
      message: "The AI service is busy right now — try again in a moment.",
      reason: "rate limited",
      retryable: true,
    };
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return {
      message: "The AI service rejected this server's API key.",
      reason: "API key rejected",
      retryable: false,
    };
  }
  if (error instanceof Anthropic.BadRequestError) {
    return {
      message: `The AI service rejected the request: ${apiErrorDetail(error)}`,
      reason: "request rejected",
      retryable: false,
    };
  }
  if (error instanceof Anthropic.APIError) {
    // InternalServerError (HTTP 5xx, incl. 529 "overloaded") AND errors that
    // arrive mid-stream (no HTTP status) both land here; the typed `type`
    // field from the error body says which kind it was.
    if (error.type === "overloaded_error") {
      return {
        message: "The AI service is overloaded right now — try again in a moment.",
        reason: "service overloaded",
        retryable: true,
      };
    }
    if (
      error instanceof Anthropic.InternalServerError ||
      error.type === "api_error" ||
      error.type === "timeout_error" ||
      error.type === "rate_limit_error"
    ) {
      return {
        message: "The AI service had a temporary problem — try again.",
        reason: "service error",
        retryable: true,
      };
    }
    return {
      message: `AI service error: ${apiErrorDetail(error)}`,
      reason: "service error",
      retryable: false,
    };
  }
  return {
    message: error instanceof Error ? error.message : "Unknown error",
    reason: "server error",
    retryable: false,
  };
}

/** One model call of the map assistant, streamed (see MapStepper in ai-map-stream.ts). */
export function createAnthropicMapStepper(
  client: Anthropic,
  tools: ToolDefinition[],
  settings: AnthropicMapSettings = mapSettingsFromEnv(),
): MapStepper {
  const anthropicTools = toAnthropicTools(tools);

  return {
    provider: "anthropic",
    model: settings.model,
    modelParameters: settings.effort ? { effort: settings.effort } : {},
    describeError: describeAnthropicError,

    async *step(request): AsyncGenerator<MapStepEvent, MapStepResult, void> {
      // Passing the signal aborts the HTTP stream when the user presses Stop.
      const stream = client.messages.stream(buildAnthropicMapParams(settings, anthropicTools, request), {
        signal: request.signal,
      });
      let completed = false;
      try {
        for await (const event of stream) {
          if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
            // The tool's name is known as soon as its block starts — long
            // before its arguments finish streaming. Early progress for the UI.
            yield { type: "tool_use_start", id: event.content_block.id, name: event.content_block.name };
          } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
            yield { type: "text_delta", text: event.delta.text };
          }
        }
        const final = await stream.finalMessage();
        completed = true;
        return {
          blocks: toNeutralBlocks(final.content),
          native: { provider: "anthropic", content: final.content },
          stopReason: toStopReason(final.stop_reason),
          usage: {
            inputTokens: final.usage.input_tokens,
            outputTokens: final.usage.output_tokens,
            cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: final.usage.cache_creation_input_tokens ?? 0,
          },
        };
      } finally {
        // The loop stopped listening early (or an error was thrown): don't
        // keep downloading a reply nobody will read.
        if (!completed) stream.abort();
      }
    },
  };
}
