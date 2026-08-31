import "server-only";

import { startObservation } from "@langfuse/tracing";
import { tracingEnabled } from "./tracing";

import Anthropic from "@anthropic-ai/sdk";
import type {
  AIProvider,
  ChatMessage,
  MapToolStreamChunk,
  ToolDefinition,
  ToolStreamChunk,
} from "./ai-provider";
import { streamMapToolResponse } from "./ai-map-stream";

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

// 📖 Learn: a "factory function" creates and returns an object. The Maps
// (assistantStore, threadStore) are closed over — each call to
// createAnthropicProvider() gets its own private store.
export function createAnthropicProvider(): AIProvider {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const assistantStore = new Map<string, StoredAssistant>();
  const threadStore = new Map<string, StoredThread>();

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

    async *streamMessageWithMapTools(
      threadId,
      content,
      ctx,
      model = "claude-haiku-4-5-20251001",
      maxTokens = 900,
    ): AsyncGenerator<MapToolStreamChunk> {
      const thread = getThread(threadId);
      const assistant = getAssistant(thread.assistantId);
      const history = thread.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const gen = streamMapToolResponse(client, {
        // The map prompt embeds live-network stats, so a fresh per-request
        // prompt (ctx.systemPrompt) beats the one stored at assistant creation.
        system: ctx.systemPrompt ?? assistant.systemPrompt,
        history,
        userMessage: content,
        model,
        maxTokens,
        ctx,
      });

      let result = await gen.next();
      while (!result.done) {
        yield result.value;
        result = await gen.next();
      }

      const { assistantText, history: nextHistory } = result.value;
      const stored = nextHistory
        .filter((m): m is { role: "user" | "assistant"; content: string } =>
          typeof m.content === "string" && (m.role === "user" || m.role === "assistant"),
        )
        .map((m) => ({ role: m.role, content: m.content }));

      if (stored.length > 0) {
        threadStore.set(threadId, { ...thread, messages: stored });
      } else if (assistantText) {
        threadStore.set(threadId, {
          ...thread,
          messages: [
            ...thread.messages,
            { role: "user", content },
            { role: "assistant", content: assistantText },
          ],
        });
      }
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
