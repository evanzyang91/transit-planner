import { beforeEach, describe, expect, it, vi } from "vitest";

import { HISTORY_LIMITS, type TranscriptMessage } from "~/lib/map-assistant-protocol";
import type { MapStepRequest, MapStepStopReason, MapStepper } from "./ai-map-stream";

/**
 * The agent loop with a FAKE stepper — no network, no model. Each test scripts
 * what the "model" does step by step and checks what the browser would
 * receive (events, in order) and what gets stored (the turn transcript).
 *
 * tools.ts is mocked so each test decides what a tool returns and how long it
 * takes. Tool names follow the real registry: rank_service_areas /
 * describe_location are READ tools, the rest are WRITE tools.
 */
vi.mock("./map-data/tools", () => ({
  READ_TOOL_NAMES: new Set(["rank_service_areas", "describe_location", "query_population"]),
  WRITE_TOOL_NAMES: new Set(["show_area", "drop_pin", "fly_to", "run_simulation", "propose_line"]),
  runReadTool: vi.fn(),
  resolveWriteTool: vi.fn(),
}));

const { runReadTool, resolveWriteTool } = await import("./map-data/tools");
const {
  runMapAgentTurn,
  CLOSING_DIRECTIVE,
  CLOSING_MAX_TOKENS,
  CUT_SHORT_NOTE,
  MAX_TOOL_LOOPS,
  OUT_OF_STEPS_REPLY,
  REFUSAL_REPLY,
} = await import("./ai-map-stream");

const runReadToolMock = vi.mocked(runReadTool);
const resolveWriteToolMock = vi.mocked(resolveWriteTool);

// ── A scripted fake model ─────────────────────────────────────────────────────

interface FakeStep {
  /** Streamed first, as separate deltas. */
  text?: string[];
  /** tool_use blocks, announced after the text. */
  tools?: Array<{ id: string; name: string; input?: Record<string, unknown> }>;
  stopReason?: MapStepStopReason;
  /** Thrown after the text has streamed (a mid-stream failure). */
  error?: Error;
  /** Provider-native content (e.g. Anthropic thinking blocks). */
  native?: unknown;
}

function fakeStepper(steps: FakeStep[]) {
  /** A deep copy of every request, taken when the call was made. */
  const requests: Array<Omit<MapStepRequest, "signal">> = [];
  const stepper: MapStepper = {
    provider: "fake",
    model: "fake-model",
    describeError: (error) => ({
      message: `described: ${error instanceof Error ? error.message : String(error)}`,
      reason: "fake failure",
      retryable: true,
    }),
    async *step(request) {
      // Deep copy (without the signal): the loop keeps mutating its own arrays.
      const snapshot = {
        system: request.system,
        messages: request.messages,
        toolChoice: request.toolChoice,
        maxTokens: request.maxTokens,
      };
      requests.push(JSON.parse(JSON.stringify(snapshot)) as Omit<MapStepRequest, "signal">);
      const script = steps[requests.length - 1];
      if (!script) throw new Error("fake stepper: no more scripted steps");

      for (const delta of script.text ?? []) yield { type: "text_delta" as const, text: delta };
      if (script.error) throw script.error;

      const blocks: Array<
        { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
      > = [];
      const text = (script.text ?? []).join("");
      if (text) blocks.push({ type: "text", text });
      for (const tool of script.tools ?? []) {
        yield { type: "tool_use_start" as const, id: tool.id, name: tool.name };
        blocks.push({ type: "tool_use", id: tool.id, name: tool.name, input: tool.input ?? {} });
      }
      return {
        blocks,
        native: script.native === undefined ? undefined : { provider: "fake", content: script.native },
        stopReason: script.stopReason ?? (script.tools?.length ? "tool_use" : "end_turn"),
        usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 90, cacheCreationTokens: 0 },
      };
    },
  };
  return { stepper, requests };
}

const SYSTEM = { staticPrompt: "static rules", dynamicContext: "today: 2026-11-12" };
// The tools are mocked, so the context is never really used.
const CTX = {} as Parameters<typeof runMapAgentTurn>[0]["ctx"];

async function runTurn(
  steps: FakeStep[],
  options: { history?: TranscriptMessage[]; signal?: AbortSignal; message?: string } = {},
) {
  const { stepper, requests } = fakeStepper(steps);
  const generator = runMapAgentTurn({
    stepper,
    system: SYSTEM,
    history: options.history ?? [],
    userMessage: options.message ?? "Where are the gaps?",
    ctx: CTX,
    signal: options.signal,
  });
  const events = [];
  let next = await generator.next();
  while (!next.done) {
    events.push(next.value);
    next = await generator.next();
  }
  return { events, result: next.value, requests };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A compact, readable trace of the events: "text:Hi", "reset", "running:t1", … */
function summarize(events: Awaited<ReturnType<typeof runTurn>>["events"]): string[] {
  return events.map((event) => {
    switch (event.type) {
      case "text":
        return `text:${event.delta}`;
      case "text_reset":
        return "reset";
      case "status":
        return `${event.state}:${event.id}`;
      case "tool_call":
        return `call:${event.name}`;
      case "error":
        return `error:${event.error}`;
      case "turn":
        return "turn";
    }
  });
}

function allBlocks(messages: TranscriptMessage[]) {
  return messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
}

/** Every tool_use is answered in the very next message, and nothing else is left over. */
function expectPaired(messages: TranscriptMessage[]) {
  messages.forEach((message, index) => {
    if (message.role !== "assistant" || typeof message.content === "string") return;
    const next = messages[index + 1];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const answered =
        next?.role === "user" &&
        typeof next.content !== "string" &&
        next.content.some((b) => b.type === "tool_result" && b.tool_use_id === block.id);
      expect(answered, `tool_use ${block.id} is answered`).toBe(true);
    }
  });
}

beforeEach(() => {
  runReadToolMock.mockReset();
  resolveWriteToolMock.mockReset();
  runReadToolMock.mockResolvedValue({ areas: [{ id: "gap_1", name: "Leaside" }] });
  resolveWriteToolMock.mockImplementation(async (name, args) => ({
    status: "rendered",
    clientName: name === "show_area" ? "highlight_area" : name,
    clientArgs: { ...args },
  }));
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("runMapAgentTurn — answers", () => {
  it("streams the text of a step without tools and ends the turn", async () => {
    const { events, result, requests } = await runTurn([{ text: ["Hello", " there."] }]);
    expect(summarize(events)).toEqual(["text:Hello", "text: there.", "turn"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.toolChoice).toBe("auto");
    expect(result.answerText).toBe("Hello there.");
    expect(result.outcome).toBe("answered");
    expect(result.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Where are the gaps?" }] },
      { role: "assistant", content: [{ type: "text", text: "Hello there." }] },
    ]);
  });

  it("sends history + the new message, and never changes the history", async () => {
    const history: TranscriptMessage[] = [
      { role: "user", content: [{ type: "text", text: "earlier question" }] },
      { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
    ];
    const before = JSON.stringify(history);
    const { requests } = await runTurn([{ text: ["ok"] }], { history });
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[0]!.system).toEqual(SYSTEM);
    expect(JSON.stringify(history)).toBe(before);
  });

  it("text then a READ tool → text_reset carrying the narration as its note", async () => {
    const { events, result } = await runTurn([
      { text: ["Let me check ", "Scarborough…"], tools: [{ id: "t1", name: "rank_service_areas" }] },
      { text: ["Scarborough has 3 gaps."] },
    ]);
    expect(summarize(events)).toEqual([
      "text:Let me check ",
      "text:Scarborough…",
      "reset",
      "running:t1",
      "done:t1",
      "text:Scarborough has 3 gaps.",
      "turn",
    ]);
    const reset = events.find((e) => e.type === "text_reset");
    expect(reset).toEqual({ type: "text_reset", note: "Let me check Scarborough…" });
    expect(result.answerText).toBe("Scarborough has 3 gaps.");
  });

  it("caps the text_reset note at 200 characters", async () => {
    const { events } = await runTurn([
      { text: ["x".repeat(500)], tools: [{ id: "t1", name: "rank_service_areas" }] },
      { text: ["done"] },
    ]);
    const reset = events.find((e) => e.type === "text_reset");
    expect(reset?.type === "text_reset" && reset.note?.length).toBe(200);
  });

  it("status events carry the tool's human label", async () => {
    const { events } = await runTurn([
      { tools: [{ id: "t1", name: "rank_service_areas" }] },
      { text: ["ok"] },
    ]);
    expect(events.find((e) => e.type === "status")).toEqual({
      type: "status",
      id: "t1",
      tool: "rank_service_areas",
      label: "Ranking service areas",
      state: "running",
    });
  });
});

describe("runMapAgentTurn — tools", () => {
  it("runs a step's calls at the same time but reports them in the model's order", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    resolveWriteToolMock.mockImplementation(async (name, args) => {
      started.push(String(args.label));
      await sleep(args.label === "slow" ? 40 : 5);
      finished.push(String(args.label));
      return { status: "rendered", clientName: name === "show_area" ? "highlight_area" : name, clientArgs: { ...args } };
    });

    const { events } = await runTurn([
      {
        text: ["Shaded **Leaside** and pinned its densest block."],
        tools: [
          { id: "w1", name: "show_area", input: { label: "slow" } },
          { id: "w2", name: "drop_pin", input: { label: "fast" } },
        ],
      },
    ]);

    // Concurrency: both started before the slow one finished; the fast one finished first.
    expect(started).toEqual(["slow", "fast"]);
    expect(finished).toEqual(["fast", "slow"]);
    // …but the browser hears about them in the model's order.
    const order = summarize(events).filter((s) => s.startsWith("call:") || s.startsWith("done:"));
    expect(order).toEqual(["call:highlight_area", "done:w1", "call:drop_pin", "done:w2"]);
  });

  it("runs WRITES after the step's READS (a write may cite what a read computes)", async () => {
    const timeline: string[] = [];
    runReadToolMock.mockImplementation(async () => {
      timeline.push("read:start");
      await sleep(20);
      timeline.push("read:end");
      return { areas: [{ id: "gap_1" }] };
    });
    resolveWriteToolMock.mockImplementation(async (_name, args) => {
      timeline.push("write:start");
      return { status: "rendered", clientName: "highlight_area", clientArgs: { ...args } };
    });

    const { events } = await runTurn([
      {
        tools: [
          { id: "w", name: "show_area", input: { id: "gap_1" } },
          { id: "r", name: "rank_service_areas" },
        ],
      },
      { text: ["Shaded the worst gap."] },
    ]);

    expect(timeline).toEqual(["read:start", "read:end", "write:start"]);
    // Still reported in the model's order (the write was first).
    const order = summarize(events).filter((s) => s.startsWith("done:") || s.startsWith("call:"));
    expect(order).toEqual(["call:highlight_area", "done:w", "done:r"]);
  });

  it("puts modelNote / modelData into the tool_result for the model", async () => {
    resolveWriteToolMock.mockResolvedValue({
      status: "rendered",
      clientName: "propose_line",
      clientArgs: { draftId: "d1" },
      modelNote: "A confirm card is open; nothing was added yet.",
      modelData: { lengthKm: 7.2 },
    } as never);
    const { result } = await runTurn([
      { tools: [{ id: "p1", name: "propose_line" }] },
      { text: ["Drafted a 7.2 km line — click Add to map to keep it."] },
    ]);
    const toolResult = allBlocks(result.messages).find((b) => b.type === "tool_result");
    expect(toolResult?.type === "tool_result" && JSON.parse(toolResult.content)).toEqual({
      status: "rendered_on_map",
      note: "A confirm card is open; nothing was added yet.",
      result: { lengthKm: 7.2 },
    });
  });

  it("a read tool that throws becomes an error tool_result and an error status", async () => {
    runReadToolMock.mockRejectedValue(new Error("census down"));
    const { events, result } = await runTurn([
      { tools: [{ id: "r1", name: "rank_service_areas" }] },
      { text: ["The census data is unavailable right now."] },
    ]);
    expect(summarize(events)).toContain("error:r1");
    const toolResult = allBlocks(result.messages).find((b) => b.type === "tool_result");
    expect(toolResult).toMatchObject({ is_error: true, content: JSON.stringify({ error: "census down" }) });
  });

  it("treats a client action name outside the contract as a rejection, not a drawing", async () => {
    resolveWriteToolMock.mockResolvedValue({ status: "rendered", clientName: "launch_rocket", clientArgs: {} });
    const { events, requests } = await runTurn([
      { text: ["Done."], tools: [{ id: "w1", name: "show_area" }] },
      { text: ["Sorry, that didn't work."] },
    ]);
    expect(summarize(events).some((s) => s.startsWith("call:"))).toBe(false);
    expect(requests).toHaveLength(2); // the model hears about it and continues
  });
});

describe("runMapAgentTurn — captions and the closing call", () => {
  it("CAPTION ACCEPTANCE: a drawing step that wrote text ends the turn with no extra call", async () => {
    const { events, result, requests } = await runTurn([
      {
        text: ["Shaded **Leaside** — 14,200 people far from transit."],
        tools: [{ id: "w1", name: "show_area", input: { id: "gap_1" } }],
      },
    ]);
    expect(requests).toHaveLength(1);
    expect(summarize(events)).toEqual([
      "text:Shaded **Leaside** — 14,200 people far from transit.",
      "running:w1",
      "call:highlight_area",
      "done:w1",
      "turn",
    ]);
    expect(result.answerText).toBe("Shaded **Leaside** — 14,200 people far from transit.");
    // The transcript ends on the tool results — still perfectly paired.
    expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expectPaired(result.messages);
  });

  it("a drawing step with NO text gets one closing call with tools switched off", async () => {
    const { events, result, requests } = await runTurn([
      { tools: [{ id: "w1", name: "fly_to", input: { bbox: [1, 2, 3, 4] } }] },
      { text: ["Moved the map to ", "**Leaside**."] },
    ]);
    expect(requests).toHaveLength(2);
    const closing = requests[1]!;
    expect(closing.toolChoice).toBe("none");
    expect(closing.maxTokens).toBe(CLOSING_MAX_TOKENS);
    // The directive rides after the tool results, never in the (cached) system prompt.
    expect(closing.system).toEqual(SYSTEM);
    const lastMessage = closing.messages.at(-1)!;
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.blocks.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(lastMessage.blocks[1]).toEqual({ type: "text", text: CLOSING_DIRECTIVE });

    expect(summarize(events)).toEqual([
      "running:w1",
      "call:fly_to",
      "done:w1",
      "text:Moved the map to ",
      "text:**Leaside**.",
      "turn",
    ]);
    // …and the stored transcript does NOT contain the directive.
    expect(JSON.stringify(result.messages)).not.toContain("system-reminder");
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: "Moved the map to **Leaside**." }] });
    expectPaired(result.messages);
  });

  it("a rejected write keeps the loop going, and the shown text is taken back", async () => {
    resolveWriteToolMock.mockResolvedValueOnce({ status: "rejected", error: "Unknown artifact id 'gap_9'." });
    const { events, result, requests } = await runTurn([
      { text: ["Shaded gap 9."], tools: [{ id: "w1", name: "show_area", input: { id: "gap_9" } }] },
      { text: ["There is no gap 9 — the ranking only found 3 areas."] },
    ]);
    expect(requests).toHaveLength(2);
    expect(summarize(events)).toEqual([
      "text:Shaded gap 9.",
      "running:w1",
      "error:w1",
      "reset",
      "text:There is no gap 9 — the ranking only found 3 areas.",
      "turn",
    ]);
    const toolResult = allBlocks(result.messages).find((b) => b.type === "tool_result");
    expect(toolResult).toMatchObject({ is_error: true });
    expect(result.answerText).toBe("There is no gap 9 — the ranking only found 3 areas.");
  });

  it("a write with results to explain (run_simulation) gets another step, not caption acceptance", async () => {
    resolveWriteToolMock.mockResolvedValue({
      status: "rendered",
      clientName: "show_simulation",
      clientArgs: { result: {} },
      modelData: { accessibilityBefore: 41, accessibilityAfter: 46 },
    } as never);
    const { events, requests } = await runTurn([
      { text: ["Running the simulation…"], tools: [{ id: "s1", name: "run_simulation" }] },
      { text: ["Transit accessibility rises from 41% to 46%."] },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.toolChoice).toBe("auto");
    expect(summarize(events)).toEqual([
      "text:Running the simulation…",
      "running:s1",
      "call:show_simulation",
      "done:s1",
      "reset",
      "text:Transit accessibility rises from 41% to 46%.",
      "turn",
    ]);
  });

  it("says so when the step budget runs out", async () => {
    const steps = Array.from({ length: MAX_TOOL_LOOPS }, (_, i) => ({
      text: [`checking ${i}`],
      tools: [{ id: `r${i}`, name: "rank_service_areas" }],
    }));
    const { events, result, requests } = await runTurn(steps);
    expect(requests).toHaveLength(MAX_TOOL_LOOPS);
    expect(summarize(events).at(-2)).toBe(`text:${OUT_OF_STEPS_REPLY}`);
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: OUT_OF_STEPS_REPLY }] });
    expectPaired(result.messages);
  });
});

describe("runMapAgentTurn — stop reasons", () => {
  it("max_tokens: keeps the text, runs no tools, appends (Reply cut short.)", async () => {
    const { events, result } = await runTurn([
      {
        text: ["Leaside is the worst"],
        tools: [{ id: "t1", name: "rank_service_areas" }],
        stopReason: "max_tokens",
      },
    ]);
    expect(runReadToolMock).not.toHaveBeenCalled();
    expect(summarize(events)).toEqual([
      "text:Leaside is the worst",
      "reset",
      "running:t1",
      "error:t1",
      `text:${CUT_SHORT_NOTE}`,
      "turn",
    ]);
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Leaside is the worst" },
        { type: "text", text: CUT_SHORT_NOTE },
      ],
    });
    expect(allBlocks(result.messages).some((b) => b.type === "tool_use")).toBe(false);
  });

  it("refusal: takes back the partial text and apologises (no retry)", async () => {
    const { events, result, requests } = await runTurn([{ text: ["Sure, here's how to"], stopReason: "refusal" }]);
    expect(requests).toHaveLength(1);
    expect(summarize(events)).toEqual(["text:Sure, here's how to", "reset", `text:${REFUSAL_REPLY}`, "turn"]);
    expect(result.messages.at(-1)).toEqual({ role: "assistant", content: [{ type: "text", text: REFUSAL_REPLY }] });
    expect(result.answerText).toBe(REFUSAL_REPLY);
  });
});

describe("runMapAgentTurn — the stored transcript", () => {
  it("passes provider-native blocks back WITHIN the turn but never stores them", async () => {
    const thinking = [
      { type: "thinking", thinking: "", signature: "sig-1" },
      { type: "tool_use", id: "r1", name: "rank_service_areas", input: {} },
    ];
    const { result, requests } = await runTurn([
      { tools: [{ id: "r1", name: "rank_service_areas" }], native: thinking },
      { text: ["Leaside is the biggest gap."] },
    ]);
    // Step 2 received step 1's native content (thinking included)…
    const sentBack = requests[1]!.messages.find((m) => m.role === "assistant");
    expect(sentBack?.native).toEqual({ provider: "fake", content: thinking });
    // …but the transcript has no trace of thinking.
    expect(JSON.stringify(result.messages)).not.toContain("thinking");
    expect(JSON.stringify(result.messages)).not.toContain("sig-1");
    expectPaired(result.messages);
  });

  it("truncates long tool results in the transcript (the model still saw them in full)", async () => {
    const big = { rows: "r".repeat(HISTORY_LIMITS.maxToolResultChars * 2) };
    runReadToolMock.mockResolvedValue(big);
    const { result, requests } = await runTurn([
      { tools: [{ id: "r1", name: "rank_service_areas" }] },
      { text: ["ok"] },
    ]);
    const sentToModel = requests[1]!.messages.at(-1)!.blocks[0]!;
    expect(sentToModel.type === "tool_result" && sentToModel.content).toBe(JSON.stringify(big));
    const stored = allBlocks(result.messages).find((b) => b.type === "tool_result");
    expect(stored?.type === "tool_result" && stored.content.length).toBe(HISTORY_LIMITS.maxToolResultChars);
  });

  it("an error mid-turn → error event, then a paired transcript ending in (Reply interrupted: …)", async () => {
    const { events, result } = await runTurn([
      { text: ["Let me look."], tools: [{ id: "r1", name: "rank_service_areas" }] },
      { text: ["Leaside is"], error: new Error("overloaded") },
    ]);
    const summary = summarize(events);
    expect(summary.slice(-3)).toEqual(["text:Leaside is", "error:described: overloaded", "turn"]);
    const errorEvent = events.find((e) => e.type === "error");
    expect(errorEvent).toEqual({ type: "error", error: "described: overloaded", retryable: true });
    expect(result.outcome).toBe("error");
    // Finished steps stay; the unfinished one keeps what the user saw + the note.
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Leaside is" },
        { type: "text", text: "(Reply interrupted: fake failure)" },
      ],
    });
    expectPaired(result.messages);
    expect(events.at(-1)).toEqual({ type: "turn", messages: result.messages });
  });

  it("an error before anything was recorded still yields user + interrupted note", async () => {
    const { result } = await runTurn([{ error: new Error("connection refused") }]);
    expect(result.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Where are the gaps?" }] },
      { role: "assistant", content: [{ type: "text", text: "(Reply interrupted: fake failure)" }] },
    ]);
  });
});

describe("runMapAgentTurn — Stop", () => {
  it("stops between steps once aborted (no further model call, no error event)", async () => {
    const controller = new AbortController();
    runReadToolMock.mockImplementation(async () => {
      controller.abort(); // the user presses Stop while a tool runs
      return { ok: true };
    });
    const { events, result, requests } = await runTurn(
      [
        { tools: [{ id: "r1", name: "rank_service_areas" }] },
        { text: ["never reached"] },
      ],
      { signal: controller.signal },
    );
    expect(requests).toHaveLength(1);
    expect(events.some((e) => e.type === "error")).toBe(false);
    expect(result.outcome).toBe("aborted");
    expect(result.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "(Reply interrupted: stopped)" }],
    });
    expectPaired(result.messages);
  });

  it("makes no model call at all when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { requests, result } = await runTurn([{ text: ["never"] }], { signal: controller.signal });
    expect(requests).toHaveLength(0);
    expect(result.outcome).toBe("aborted");
  });

  it("doesn't run the tools of a step that finished after Stop was pressed", async () => {
    const controller = new AbortController();
    const { stepper, requests } = fakeStepper([]);
    // A stepper that notices nothing: it finishes its step even though Stop was pressed mid-way.
    stepper.step = async function* (request) {
      requests.push({ ...request, messages: [] });
      yield { type: "tool_use_start", id: "r1", name: "rank_service_areas" };
      controller.abort();
      return {
        blocks: [{ type: "tool_use", id: "r1", name: "rank_service_areas", input: {} }],
        stopReason: "tool_use",
      };
    };
    const generator = runMapAgentTurn({
      stepper,
      system: SYSTEM,
      history: [],
      userMessage: "q",
      ctx: CTX,
      signal: controller.signal,
    });
    let next = await generator.next();
    while (!next.done) next = await generator.next();
    expect(runReadToolMock).not.toHaveBeenCalled();
    expect(next.value.outcome).toBe("aborted");
    expectPaired(next.value.messages);
  });
});
