import {
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
  type GoogleGenerativeAI,
} from "@google/generative-ai";
import { describe, expect, it } from "vitest";

import type { ToolDefinition } from "./ai-provider";
import type { LoopMessage, MapStepRequest } from "./ai-map-stream";
import {
  GEMINI_MAP_MODEL,
  createGeminiMapStepper,
  describeGeminiError,
  toGeminiContents,
  toGeminiSchema,
} from "./gemini";

/**
 * The Gemini adapter for the shared map-assistant loop. Gemini differs from
 * Anthropic in three ways that matter here: roles are user/model/function,
 * tool results are matched by tool NAME (not id), and its schema dialect is
 * stricter. All pure — no network.
 */

const TOOL_DEFS: ToolDefinition[] = [
  { name: "rank_service_areas", description: "Rank areas", inputSchema: { type: "object", properties: { order: { type: "string" } } } },
  { name: "network_coverage", description: "Coverage", inputSchema: { type: "object", properties: {} } },
];

describe("toGeminiContents", () => {
  it("maps a tool round to model functionCall + function functionResponse (matched by name)", () => {
    const messages: LoopMessage[] = [
      { role: "user", blocks: [{ type: "text", text: "Where are the gaps?" }] },
      {
        role: "assistant",
        blocks: [
          { type: "text", text: "Checking." },
          { type: "tool_use", id: "toolu_1", name: "rank_service_areas", input: { order: "least_served" } },
        ],
      },
      { role: "user", blocks: [{ type: "tool_result", tool_use_id: "toolu_1", content: '{"count":2}' }] },
      { role: "assistant", blocks: [{ type: "text", text: "Two gaps." }] },
    ];
    expect(toGeminiContents(messages)).toEqual([
      { role: "user", parts: [{ text: "Where are the gaps?" }] },
      {
        role: "model",
        parts: [{ text: "Checking." }, { functionCall: { name: "rank_service_areas", args: { order: "least_served" } } }],
      },
      { role: "function", parts: [{ functionResponse: { name: "rank_service_areas", response: { count: 2 } } }] },
      { role: "model", parts: [{ text: "Two gaps." }] },
    ]);
  });

  it("wraps non-object and unreadable results so the response is always an object", () => {
    const contents = toGeminiContents([
      { role: "user", blocks: [{ type: "text", text: "q" }] },
      {
        role: "assistant",
        blocks: [
          { type: "tool_use", id: "a", name: "rank_service_areas", input: {} },
          { type: "tool_use", id: "b", name: "rank_service_areas", input: {} },
          { type: "tool_use", id: "c", name: "rank_service_areas", input: {} },
        ],
      },
      {
        role: "user",
        blocks: [
          { type: "tool_result", tool_use_id: "a", content: "[1,2]" },
          { type: "tool_result", tool_use_id: "b", content: '{"cut off…', is_error: true },
          { type: "tool_result", tool_use_id: "c", content: "plain words" },
        ],
      },
    ]);
    const responses = contents[2]!.parts.map((p) => ("functionResponse" in p ? p.functionResponse?.response : null));
    expect(responses).toEqual([{ result: [1, 2] }, { error: '{"cut off…' }, { result: "plain words" }]);
  });

  it("puts typed text after tool results into its own user content, and joins same-role neighbours", () => {
    const contents = toGeminiContents([
      { role: "user", blocks: [{ type: "text", text: "shade it" }] },
      { role: "assistant", blocks: [{ type: "tool_use", id: "t1", name: "rank_service_areas", input: {} }] },
      { role: "user", blocks: [{ type: "tool_result", tool_use_id: "t1", content: "{}" }] },
      { role: "user", blocks: [{ type: "text", text: "now explain" }] },
      { role: "user", blocks: [{ type: "text", text: "briefly" }] },
    ]);
    expect(contents.map((c) => c.role)).toEqual(["user", "model", "function", "user"]);
    expect(contents[3]!.parts).toEqual([{ text: "now explain" }, { text: "briefly" }]);
  });

  it("skips a tool result whose call it can't find", () => {
    const contents = toGeminiContents([
      { role: "user", blocks: [{ type: "text", text: "q" }] },
      { role: "user", blocks: [{ type: "tool_result", tool_use_id: "ghost", content: "{}" }] },
    ]);
    expect(contents).toEqual([{ role: "user", parts: [{ text: "q" }] }]);
  });
});

describe("toGeminiSchema", () => {
  it("keeps the keywords Gemini knows, recursively, and drops the rest", () => {
    const schema = toGeminiSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        bbox: { type: "array", items: { type: "number", $comment: "x" }, minItems: 4, maxItems: 4 },
        mode: { type: "string", enum: ["walking", "cycling"] },
      },
      required: ["bbox"],
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
        mode: { type: "string", enum: ["walking", "cycling"] },
      },
      required: ["bbox"],
    });
  });

  it("turns a non-string enum into a description hint and a nullable type union into nullable", () => {
    expect(toGeminiSchema({ type: "number", enum: [15, 30], description: "Minutes." })).toEqual({
      type: "number",
      description: "Minutes. One of: 15, 30.",
    });
    expect(toGeminiSchema({ type: ["string", "null"] })).toEqual({ type: "string", nullable: true });
  });
});

describe("describeGeminiError", () => {
  it("retries rate limits, server errors and network failures, not bad requests", () => {
    expect(describeGeminiError(new GoogleGenerativeAIFetchError("x", 429)).retryable).toBe(true);
    expect(describeGeminiError(new GoogleGenerativeAIFetchError("x", 503)).retryable).toBe(true);
    expect(describeGeminiError(new GoogleGenerativeAIFetchError("x", 400)).retryable).toBe(false);
    expect(describeGeminiError(new GoogleGenerativeAIError("fetch failed")).retryable).toBe(true);
    expect(describeGeminiError(new Error("bug")).retryable).toBe(false);
  });
});

describe("createGeminiMapStepper", () => {
  /** A stand-in for genAI.getGenerativeModel(...).generateContentStream(...). */
  function fakeGenAI(chunks: unknown[]) {
    const calls: Array<{ modelParams: Record<string, unknown>; request: unknown; options: unknown }> = [];
    const genAI = {
      getGenerativeModel(modelParams: Record<string, unknown>) {
        return {
          async generateContentStream(request: unknown, options: unknown) {
            calls.push({ modelParams, request, options });
            return {
              stream: (async function* () {
                for (const chunk of chunks) yield chunk;
              })(),
            };
          },
        };
      },
    } as unknown as GoogleGenerativeAI;
    return { genAI, calls };
  }

  function request(overrides: Partial<MapStepRequest> = {}): MapStepRequest {
    return {
      system: { staticPrompt: "STATIC", dynamicContext: "DYNAMIC" },
      messages: [{ role: "user", blocks: [{ type: "text", text: "q" }] }],
      toolChoice: "auto",
      maxTokens: 2048,
      ...overrides,
    };
  }

  async function drain(generator: ReturnType<ReturnType<typeof createGeminiMapStepper>["step"]>) {
    const events = [];
    let next = await generator.next();
    while (!next.done) {
      events.push(next.value);
      next = await generator.next();
    }
    return { events, result: next.value };
  }

  it("streams text, turns function calls into tool_use blocks with Anthropic-safe ids", async () => {
    const { genAI, calls } = fakeGenAI([
      { candidates: [{ content: { role: "model", parts: [{ text: "Let me " }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "check." }] } }] },
      {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { name: "rank_service_areas", args: { order: "least_served" } } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 20, totalTokenCount: 1020, cachedContentTokenCount: 600 },
      },
    ]);
    const controller = new AbortController();
    const stepper = createGeminiMapStepper(genAI, TOOL_DEFS);
    expect(stepper.model).toBe(GEMINI_MAP_MODEL);

    const { events, result } = await drain(stepper.step(request({ signal: controller.signal })));
    expect(events.slice(0, 2)).toEqual([
      { type: "text_delta", text: "Let me " },
      { type: "text_delta", text: "check." },
    ]);
    const toolStart = events[2]!;
    expect(toolStart.type).toBe("tool_use_start");
    const id = toolStart.type === "tool_use_start" ? toolStart.id : "";
    expect(id).toMatch(/^gm_[A-Za-z0-9]+$/);
    expect(result.blocks).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id, name: "rank_service_areas", input: { order: "least_served" } },
    ]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.usage).toEqual({ inputTokens: 400, outputTokens: 20, cacheReadTokens: 600 });

    // Both prompt halves, the tool mode and the Stop signal reach the SDK.
    expect(calls[0]!.modelParams.systemInstruction).toBe("STATIC\n\nDYNAMIC");
    expect(calls[0]!.modelParams.toolConfig).toEqual({ functionCallingConfig: { mode: "AUTO" } });
    expect(calls[0]!.options).toEqual({ signal: controller.signal });
    // A tool without arguments is declared without `parameters` (Gemini rejects empty objects).
    const declarations = (calls[0]!.modelParams.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]!
      .functionDeclarations;
    expect("parameters" in declarations[1]!).toBe(false);
  });

  it("uses mode NONE for the closing call and maps finish reasons", async () => {
    for (const [finishReason, expected] of [
      ["MAX_TOKENS", "max_tokens"],
      ["SAFETY", "refusal"],
      ["STOP", "end_turn"],
    ] as const) {
      const { genAI, calls } = fakeGenAI([
        { candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason }] },
      ]);
      const { result } = await drain(createGeminiMapStepper(genAI, TOOL_DEFS).step(request({ toolChoice: "none" })));
      expect(result.stopReason).toBe(expected);
      expect(calls[0]!.modelParams.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    }
  });

  it("treats a blocked prompt as a refusal", async () => {
    const { genAI } = fakeGenAI([{ promptFeedback: { blockReason: "SAFETY" } }]);
    const { result } = await drain(createGeminiMapStepper(genAI, TOOL_DEFS).step(request()));
    expect(result.stopReason).toBe("refusal");
  });
});
