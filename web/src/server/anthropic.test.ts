import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ToolDefinition } from "./ai-provider";
import type { LoopMessage, MapStepRequest } from "./ai-map-stream";
import {
  DEFAULT_MAP_MODEL,
  buildAnthropicMapParams,
  createAnthropicMapStepper,
  createAnthropicProvider,
  describeAnthropicError,
  mapSettingsFromEnv,
  toAnthropicMessages,
  toAnthropicTools,
} from "./anthropic";

/**
 * Regression: "Unknown thread: <uuid>".
 *
 * Assistants and threads live in a Map inside the provider closure — process
 * memory. The browser persists its ids in localStorage and keeps sending them,
 * so after a hot reload, a restart, or a hop to another serverless instance the
 * server gets ids it has never seen and getThread() threw.
 *
 * hasSession() lets the route detect that and open a fresh session instead.
 */
describe("provider session tracking", () => {
  it("reports a session it just created", async () => {
    const p = createAnthropicProvider();
    const assistantId = await p.createAssistant("T", "prompt");
    const threadId = await p.createThread(assistantId);
    expect(p.hasSession!(assistantId, threadId)).toBe(true);
  });

  it("reports false for an unknown thread id", async () => {
    const p = createAnthropicProvider();
    const assistantId = await p.createAssistant("T", "prompt");
    expect(p.hasSession!(assistantId, crypto.randomUUID())).toBe(false);
  });

  it("reports false for an unknown assistant id", async () => {
    const p = createAnthropicProvider();
    const assistantId = await p.createAssistant("T", "prompt");
    const threadId = await p.createThread(assistantId);
    expect(p.hasSession!(crypto.randomUUID(), threadId)).toBe(false);
  });

  it("reports false across provider instances — the actual restart case", () => {
    // A new provider is what a hot reload or a fresh lambda produces: same ids
    // from the client, empty stores on the server.
    const before = createAnthropicProvider();
    const after = createAnthropicProvider();
    return (async () => {
      const assistantId = await before.createAssistant("T", "prompt");
      const threadId = await before.createThread(assistantId);
      expect(before.hasSession!(assistantId, threadId)).toBe(true);
      expect(after.hasSession!(assistantId, threadId)).toBe(false);
    })();
  });
});

// ── Ask AI map assistant: the Anthropic stepper ───────────────────────────────
//
// Pure pieces only (request shape, message conversion, error mapping) plus the
// stepper driven by a fake client — no network.

const TOOL_DEFS: ToolDefinition[] = [
  { name: "rank_service_areas", description: "Rank areas", inputSchema: { type: "object", properties: {} } },
  { name: "show_area", description: "Shade an area", inputSchema: { type: "object", properties: { id: { type: "string" } } } },
];

function request(overrides: Partial<MapStepRequest> = {}): MapStepRequest {
  return {
    system: { staticPrompt: "STATIC RULES", dynamicContext: "Today: 2026-11-12" },
    messages: [{ role: "user", blocks: [{ type: "text", text: "Where are the gaps?" }] }],
    toolChoice: "auto",
    maxTokens: 2048,
    ...overrides,
  };
}

describe("mapSettingsFromEnv", () => {
  it("defaults to Claude Haiku 5.5 at low effort", () => {
    expect(mapSettingsFromEnv({} as NodeJS.ProcessEnv)).toEqual({ model: DEFAULT_MAP_MODEL, effort: "low" });
    expect(DEFAULT_MAP_MODEL).toBe("claude-haiku-5-5");
  });

  it("lets env vars override the model and effort, or drop effort entirely", () => {
    const env = { MAP_ASSISTANT_MODEL: "claude-sonnet-5-5", MAP_ASSISTANT_EFFORT: "medium" } as unknown as NodeJS.ProcessEnv;
    expect(mapSettingsFromEnv(env)).toEqual({ model: "claude-sonnet-5-5", effort: "medium" });
    expect(mapSettingsFromEnv({ MAP_ASSISTANT_EFFORT: "none" } as unknown as NodeJS.ProcessEnv).effort).toBeNull();
  });

  it("ignores an unknown effort value (with a warning)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(mapSettingsFromEnv({ MAP_ASSISTANT_EFFORT: "turbo" } as unknown as NodeJS.ProcessEnv).effort).toBe("low");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("buildAnthropicMapParams", () => {
  const tools = toAnthropicTools(TOOL_DEFS);

  it("caches the static prompt and the growing conversation, with effort and no sampling params", () => {
    const params = buildAnthropicMapParams({ model: "claude-haiku-5-5", effort: "low" }, tools, request());
    expect(params.model).toBe("claude-haiku-5-5");
    expect(params.max_tokens).toBe(2048);
    expect(params.system).toEqual([
      { type: "text", text: "STATIC RULES", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Today: 2026-11-12" },
    ]);
    expect(params.cache_control).toEqual({ type: "ephemeral" });
    expect(params.output_config).toEqual({ effort: "low" });
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect(params.tools?.map((t) => ("name" in t ? t.name : ""))).toEqual(["rank_service_areas", "show_area"]);
    // Haiku 5.5: thinking is adaptive by default; sampling params and prefill would 400.
    expect("thinking" in params).toBe(false);
    expect("temperature" in params).toBe(false);
    expect(params.messages.at(-1)?.role).toBe("user");
  });

  it("drops an empty dynamic block and, if asked, the effort", () => {
    const params = buildAnthropicMapParams(
      { model: "claude-haiku-4-5", effort: null },
      tools,
      request({ system: { staticPrompt: "S", dynamicContext: "  " }, toolChoice: "none", maxTokens: 1024 }),
    );
    expect(params.system).toHaveLength(1);
    expect("output_config" in params).toBe(false);
    expect(params.tool_choice).toEqual({ type: "none" });
  });

  it("produces byte-identical tools + system prefixes on every call (cacheable)", () => {
    const a = buildAnthropicMapParams({ model: "m", effort: "low" }, toAnthropicTools(TOOL_DEFS), request());
    const b = buildAnthropicMapParams({ model: "m", effort: "low" }, toAnthropicTools(TOOL_DEFS), request());
    expect(JSON.stringify(a.tools)).toBe(JSON.stringify(b.tools));
    expect(JSON.stringify((a.system as unknown[])[0])).toBe(JSON.stringify((b.system as unknown[])[0]));
  });
});

describe("toAnthropicMessages", () => {
  it("sends this turn's native content back verbatim (thinking included)", () => {
    const native = [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "tool_use", id: "t1", name: "rank_service_areas", input: {} },
    ];
    const messages: LoopMessage[] = [
      { role: "user", blocks: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        blocks: [{ type: "tool_use", id: "t1", name: "rank_service_areas", input: {} }],
        native: { provider: "anthropic", content: native },
      },
      { role: "user", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
    ];
    const out = toAnthropicMessages(messages);
    expect(out[1]).toEqual({ role: "assistant", content: native });
    expect(out[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] });
  });

  it("ignores another provider's native content and rebuilds from neutral blocks", () => {
    const out = toAnthropicMessages([
      { role: "user", blocks: [{ type: "text", text: "q" }] },
      { role: "assistant", blocks: [{ type: "text", text: "a" }], native: { provider: "gemini", content: [{ x: 1 }] } },
    ]);
    expect(out[1]).toEqual({ role: "assistant", content: [{ type: "text", text: "a" }] });
  });

  it("joins neighbours with the same role: tool results first, then the new question", () => {
    const out = toAnthropicMessages([
      { role: "user", blocks: [{ type: "text", text: "shade it" }] },
      { role: "assistant", blocks: [{ type: "text", text: "Shaded." }, { type: "tool_use", id: "t1", name: "show_area", input: {} }] },
      { role: "user", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "{}", is_error: true }] },
      { role: "user", blocks: [{ type: "text", text: "next question" }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "{}", is_error: true },
        { type: "text", text: "next question" },
      ],
    });
  });
});

describe("describeAnthropicError", () => {
  const headers = new Headers();

  it("marks rate limits, server errors, overloads and network failures as retryable", () => {
    const rateLimited = new Anthropic.RateLimitError(429, { error: { type: "rate_limit_error" } }, "slow down", headers);
    const serverError = new Anthropic.InternalServerError(500, { error: { type: "api_error" } }, "boom", headers);
    const overloadedMidStream = new Anthropic.APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      undefined,
      undefined,
      "overloaded_error",
    );
    const offline = new Anthropic.APIConnectionError({ message: "fetch failed" });
    const timeout = new Anthropic.APIConnectionTimeoutError();
    for (const error of [rateLimited, serverError, overloadedMidStream, offline, timeout]) {
      expect(describeAnthropicError(error).retryable).toBe(true);
    }
    expect(describeAnthropicError(overloadedMidStream).message).toMatch(/overloaded/i);
    expect(describeAnthropicError(timeout).reason).toBe("timed out");
  });

  it("does not retry a rejected request, and shows the API's own reason", () => {
    const bad = new Anthropic.BadRequestError(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "prompt is too long" } },
      "400 …",
      headers,
    );
    const info = describeAnthropicError(bad);
    expect(info.retryable).toBe(false);
    expect(info.message).toContain("prompt is too long");
  });
});

describe("createAnthropicMapStepper", () => {
  /** A stand-in for client.messages.stream(): replays SSE events, then a final message. */
  function fakeClient(events: unknown[], finalMessage: unknown) {
    const calls: Array<{ params: unknown; options: unknown }> = [];
    const abort = vi.fn();
    const client = {
      messages: {
        stream(params: unknown, options: unknown) {
          calls.push({ params, options });
          return {
            async *[Symbol.asyncIterator]() {
              for (const event of events) yield event;
            },
            finalMessage: async () => finalMessage,
            abort,
          };
        },
      },
    } as unknown as Anthropic;
    return { client, calls, abort };
  }

  it("streams text and tool starts, reads the final blocks by type, and reports cache usage", async () => {
    const final = {
      content: [
        { type: "thinking", thinking: "", signature: "sig" },
        { type: "text", text: "Checking.", citations: null },
        { type: "tool_use", id: "toolu_1", name: "rank_service_areas", input: { order: "least_served" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    };
    const { client, calls } = fakeClient(
      [
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Checking." } },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "rank_service_areas", input: {} } },
      ],
      final,
    );
    const controller = new AbortController();
    const stepper = createAnthropicMapStepper(client, TOOL_DEFS, { model: "claude-haiku-5-5", effort: "low" });
    expect(stepper.model).toBe("claude-haiku-5-5");

    const generator = stepper.step(request({ signal: controller.signal }));
    const events = [];
    let next = await generator.next();
    while (!next.done) {
      events.push(next.value);
      next = await generator.next();
    }

    expect(events).toEqual([
      { type: "text_delta", text: "Checking." },
      { type: "tool_use_start", id: "toolu_1", name: "rank_service_areas" },
    ]);
    expect(next.value.blocks).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "rank_service_areas", input: { order: "least_served" } },
    ]);
    expect(next.value.native).toEqual({ provider: "anthropic", content: final.content });
    expect(next.value.stopReason).toBe("tool_use");
    expect(next.value.usage).toEqual({ inputTokens: 40, outputTokens: 12, cacheReadTokens: 3000, cacheCreationTokens: 0 });
    // The Stop signal reaches the SDK request.
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
  });

  it("maps refusal and max_tokens stop reasons", async () => {
    for (const [apiReason, expected] of [
      ["refusal", "refusal"],
      ["max_tokens", "max_tokens"],
      ["end_turn", "end_turn"],
    ] as const) {
      const { client } = fakeClient([], {
        content: [],
        stop_reason: apiReason,
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null },
      });
      const stepper = createAnthropicMapStepper(client, TOOL_DEFS, { model: "m", effort: "low" });
      const generator = stepper.step(request());
      let next = await generator.next();
      while (!next.done) next = await generator.next();
      expect(next.value.stopReason).toBe(expected);
    }
  });

  it("aborts the HTTP stream when the loop stops listening early", async () => {
    const { client, abort } = fakeClient(
      [
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "a" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "b" } },
      ],
      { content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
    );
    const stepper = createAnthropicMapStepper(client, TOOL_DEFS, { model: "m", effort: "low" });
    const generator = stepper.step(request());
    await generator.next(); // first delta
    await generator.return(undefined as never);
    expect(abort).toHaveBeenCalled();
  });
});
