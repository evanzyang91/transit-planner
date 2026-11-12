import { describe, expect, it } from "vitest";
import {
  MAX_ARRAY_ITEMS_KEPT,
  MAX_STRING_CHARS_KEPT,
  applyEvent,
  applySsePayload,
  buildRequestBody,
  compactForLog,
  createTurnRecord,
  finishTurn,
  markFirstByte,
  readTurnStream,
  resolveTurns,
  runConversation,
  splitSseEvents,
} from "./conversation.mjs";

/** One SSE event exactly as the server writes it. */
function sse(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Feeds raw SSE text into a fresh record the same way run.mjs does: chunk by
 * chunk, carrying the unfinished tail over. Each chunk says when it "arrived".
 */
function feedChunks(chunks) {
  const record = createTurnRecord();
  let buffer = "";
  for (const chunk of chunks) {
    markFirstByte(record, chunk.atMs);
    buffer += chunk.text;
    const { payloads, rest } = splitSseEvents(buffer);
    buffer = rest;
    for (const payload of payloads) applySsePayload(record, payload, chunk.atMs);
  }
  return { record, buffer };
}

describe("splitSseEvents", () => {
  it("returns complete events and keeps the unfinished tail", () => {
    const { payloads, rest } = splitSseEvents(`${sse({ type: "start", model: "m" })}data: {"type":"te`);
    expect(payloads).toEqual(['{"type":"start","model":"m"}']);
    expect(rest).toBe('data: {"type":"te');
  });

  it("reassembles an event that was cut across two network chunks", () => {
    const whole = sse({ type: "text", delta: "Hello" });
    const cutAt = 12; // somewhere inside the JSON
    const { record, buffer } = feedChunks([
      { text: whole.slice(0, cutAt), atMs: 5 },
      { text: whole.slice(cutAt), atMs: 9 },
    ]);
    expect(record.text).toBe("Hello");
    expect(record.errors).toEqual([]);
    expect(buffer).toBe("");
  });

  it("ignores non-data lines and joins multi-line data with a newline", () => {
    const { payloads } = splitSseEvents(": keep-alive\n\nevent: x\ndata: line one\ndata:line two\n\n");
    expect(payloads).toEqual(["line one\nline two"]);
  });
});

describe("a full turn, event by event", () => {
  it("records the answer, the map actions, the steps and every latency mark", () => {
    const transcript = [
      { role: "user", content: "Turn on the transit desert layer" },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];
    const { record } = feedChunks([
      { text: sse({ type: "start", model: "claude-haiku-5-5" }), atMs: 40 },
      {
        text: sse({ type: "status", id: "s1", tool: "set_map_layers", label: "Switching map layers", state: "running" }),
        atMs: 900,
      },
      {
        text:
          sse({ type: "tool_call", name: "set_map_layers", args: { layers: [{ id: "transitDesert", on: true }] } }) +
          sse({ type: "status", id: "s1", tool: "set_map_layers", label: "Switching map layers", state: "done" }),
        atMs: 950,
      },
      { text: sse({ type: "text", delta: "The transit desert " }), atMs: 1500 },
      { text: sse({ type: "text", delta: "layer is on." }), atMs: 1600 },
      { text: sse({ type: "turn", messages: transcript }) + sse({ type: "done" }), atMs: 1700 },
    ]);
    finishTurn(record, 1750);

    expect(record.model).toBe("claude-haiku-5-5");
    expect(record.text).toBe("The transit desert layer is on.");
    expect(record.toolCalls).toEqual([
      { name: "set_map_layers", args: { layers: [{ id: "transitDesert", on: true }] } },
    ]);
    // The second status event (same id) updates the step instead of adding one.
    expect(record.steps).toEqual([{ id: "s1", tool: "set_map_layers", label: "Switching map layers", state: "done" }]);
    expect(record.transcript).toEqual(transcript);
    expect(record.latency).toEqual({ ttfbMs: 40, firstUiEventMs: 900, firstTextMs: 1500, totalMs: 1700 });
    expect(record.errors).toEqual([]);
  });

  it("drops narration on text_reset, keeps its note, and still times the first text the user saw", () => {
    const record = createTurnRecord();
    applyEvent(record, { type: "text", delta: "Let me check Scarborough…" }, 300);
    applyEvent(record, { type: "text_reset", note: "Checking Scarborough" }, 800);
    applyEvent(record, { type: "text", delta: "Malvern is the worst-served area." }, 2000);

    expect(record.text).toBe("Malvern is the worst-served area.");
    expect(record.notes).toEqual(["Checking Scarborough"]);
    expect(record.latency.firstTextMs).toBe(300);
  });

  it("counts a tool_call as the first UI event when no status came before it", () => {
    const record = createTurnRecord();
    applyEvent(record, { type: "tool_call", name: "focus", args: { target: "route", routeId: "line-2" } }, 1200);
    expect(record.latency.firstUiEventMs).toBe(1200);
  });

  it("fails the turn on an error event (and still records the turn + done that follow it)", () => {
    const { record } = feedChunks([
      { text: sse({ type: "start", model: "m" }), atMs: 10 },
      { text: sse({ type: "error", error: "Overloaded", retryable: true }), atMs: 500 },
      { text: sse({ type: "turn", messages: [{ role: "user", content: "hi" }] }) + sse({ type: "done" }), atMs: 510 },
    ]);
    finishTurn(record, 520);
    expect(record.errors).toEqual(["server sent an error event: Overloaded (retryable)"]);
    expect(record.transcript).toEqual([{ role: "user", content: "hi" }]);
  });

  it("does not fail the turn when a step ends in error (a rejected tool can be the right outcome)", () => {
    const record = createTurnRecord();
    applyEvent(record, { type: "status", id: "p1", tool: "drop_pin", label: "Dropping a pin", state: "running" }, 100);
    applyEvent(record, { type: "status", id: "p1", tool: "drop_pin", label: "Dropping a pin", state: "error" }, 150);
    expect(record.steps[0].state).toBe("error");
    expect(record.errors).toEqual([]);
  });

  it("fails on a payload that is not JSON instead of skipping it", () => {
    const record = createTurnRecord();
    applySsePayload(record, '{"type":"tool_call", broken', 100);
    expect(record.errors).toHaveLength(1);
    expect(record.errors[0]).toMatch(/^malformed SSE payload/);
  });

  it("accepts the old [DONE] sentinel and ignores unknown or legacy events", () => {
    const record = createTurnRecord();
    applySsePayload(record, JSON.stringify({ type: "metadata", assistantId: "a", threadId: "t" }), 10);
    applySsePayload(record, JSON.stringify({ type: "something_new", x: 1 }), 20);
    applySsePayload(record, "[DONE]", 30);
    expect(record.sawDone).toBe(true);
    expect(record.latency.totalMs).toBe(30);
    expect(record.errors).toEqual([]);
  });

  it("keeps the first done as the finish line", () => {
    const record = createTurnRecord();
    applyEvent(record, { type: "done" }, 100);
    applyEvent(record, { type: "done" }, 900);
    expect(record.latency.totalMs).toBe(100);
  });
});

describe("finishTurn", () => {
  it("flags a stream that closed without turn and done, and uses the close time as the total", () => {
    const record = createTurnRecord();
    applyEvent(record, { type: "text", delta: "partial" }, 200);
    finishTurn(record, 1234);
    expect(record.latency.totalMs).toBe(1234);
    expect(record.errors).toEqual([
      "protocol: the stream ended without a done event",
      "protocol: no turn event, so this turn could not be saved to the conversation history",
    ]);
  });

  it("adds nothing to a complete turn", () => {
    const record = createTurnRecord();
    applyEvent(record, { type: "turn", messages: [] }, 100);
    applyEvent(record, { type: "done" }, 110);
    finishTurn(record, 150);
    expect(record.latency.totalMs).toBe(110);
    expect(record.errors).toEqual([]);
  });

  it("flags a turn event without a messages array", () => {
    const record = createTurnRecord();
    applyEvent(record, { type: "turn" }, 100);
    expect(record.errors).toEqual(["protocol: turn event without a messages array"]);
  });
});

describe("readTurnStream", () => {
  /** A response body that delivers exactly these byte chunks, then closes. */
  function streamOf(byteChunks) {
    return new ReadableStream({
      start(controller) {
        for (const chunk of byteChunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  it("survives chunks cut inside an event and inside a multi-byte character, and parses a last event with no blank line after it", async () => {
    const wire =
      sse({ type: "start", model: "m" }) +
      sse({ type: "status", id: "s1", tool: "lookup_app_docs", label: "Reading the app guide", state: "running" }) +
      sse({ type: "text", delta: "Plans — needs sign-in." }) +
      sse({ type: "turn", messages: [] }) +
      `data: ${JSON.stringify({ type: "done" })}`; // no trailing "\n\n"
    const bytes = new TextEncoder().encode(wire);
    const emDashStart = bytes.indexOf(0xe2); // "—" is the 3 bytes E2 80 94 in UTF-8
    const chunks = [bytes.slice(0, 10), bytes.slice(10, emDashStart + 1), bytes.slice(emDashStart + 1)];

    // A fake clock: 100 ms later on every reading (one per chunk, one at close).
    let fakeNow = 0;
    const clock = () => {
      fakeNow += 100;
      return fakeNow;
    };

    const record = createTurnRecord();
    await readTurnStream(streamOf(chunks), record, clock);

    expect(record.text).toBe("Plans — needs sign-in.");
    expect(record.steps.map((step) => step.tool)).toEqual(["lookup_app_docs"]);
    expect(record.latency).toEqual({ ttfbMs: 100, firstUiEventMs: 200, firstTextMs: 300, totalMs: 400 });
    expect(record.errors).toEqual([]);
  });

  it("rejects when the stream breaks, so run.mjs can record the failure", async () => {
    const broken = new ReadableStream({
      start(controller) {
        controller.error(new Error("socket hang up"));
      },
    });
    await expect(readTurnStream(broken, createTurnRecord(), () => 1)).rejects.toThrow("socket hang up");
  });
});

describe("runConversation", () => {
  /**
   * A fake chat server: answers turn N with the events from scriptedTurns[N]
   * and remembers every request it received.
   */
  function fakeServer(scriptedTurns) {
    const requests = [];
    const send = async (request) => {
      requests.push(request);
      const record = createTurnRecord();
      const events = scriptedTurns[requests.length - 1];
      events.forEach((event, index) => applyEvent(record, event, (index + 1) * 100));
      finishTurn(record, events.length * 100 + 50);
      return record;
    };
    return { send, requests };
  }

  const turn1Transcript = [
    { role: "user", content: "What's the worst-served part of Scarborough?" },
    { role: "assistant", content: [{ type: "text", text: "Malvern." }] },
  ];
  const turn2Transcript = [
    { role: "user", content: "Now shade it on the map." },
    { role: "assistant", content: [{ type: "text", text: "Shaded." }] },
  ];

  it("sends each turn with the history of the turns before it, and a fresh benchmarkRunId", async () => {
    const ui = { v: 1, layers: [] };
    const server = fakeServer([
      [
        { type: "start", model: "claude-haiku-5-5" },
        { type: "tool_call", name: "highlight_area", args: { areaId: "gap_1" } },
        { type: "text", delta: "Malvern." },
        { type: "turn", messages: turn1Transcript },
        { type: "done" },
      ],
      [
        { type: "text", delta: "Shaded." },
        { type: "turn", messages: turn2Transcript },
        { type: "done" },
      ],
    ]);
    const finishedTurns = [];

    const result = await runConversation(
      resolveTurns({ turns: [{ message: "What's the worst-served part of Scarborough?", ui }, { message: "Now shade it on the map." }] }),
      { send: server.send, onTurnDone: (turnIndex) => finishedTurns.push(turnIndex) },
    );

    expect(server.requests.map((request) => request.history)).toEqual([[], turn1Transcript]);
    expect(server.requests[1].ui).toBe(ui); // inherited from turn 1
    const [firstId, secondId] = server.requests.map((request) => request.benchmarkRunId);
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondId).not.toBe(firstId);
    expect(result.lastBenchmarkRunId).toBe(secondId);

    expect(result.text).toBe("Shaded.");
    expect(result.turnToolCalls).toEqual([[{ name: "highlight_area", args: { areaId: "gap_1" } }], []]);
    expect(result.model).toBe("claude-haiku-5-5");
    expect(result.errors).toEqual([]);
    expect(result.turns.map((turn) => [turn.ok, turn.benchmarkRunId])).toEqual([
      [true, firstId],
      [true, secondId],
    ]);
    expect(finishedTurns).toEqual([0, 1]);
  });

  it("stops at the first failed turn and labels its errors with the turn number", async () => {
    const server = fakeServer([
      [
        { type: "error", error: "boom" },
        { type: "turn", messages: turn1Transcript },
        { type: "done" },
      ],
      [{ type: "text", delta: "never sent" }],
    ]);
    const result = await runConversation(resolveTurns({ turns: [{ message: "one" }, { message: "two" }] }), {
      send: server.send,
    });

    expect(server.requests).toHaveLength(1);
    expect(result.errors).toEqual(["turn 1: server sent an error event: boom"]);
    expect(result.turns.map((turn) => turn.ok)).toEqual([false]);
  });

  it("leaves a one-turn item's errors unlabelled", async () => {
    const server = fakeServer([[{ type: "text", delta: "cut off" }]]); // no turn, no done
    const result = await runConversation(resolveTurns({ message: "one" }), { send: server.send });
    expect(result.errors).toEqual([
      "protocol: the stream ended without a done event",
      "protocol: no turn event, so this turn could not be saved to the conversation history",
    ]);
  });
});

describe("compactForLog", () => {
  it("cuts long arrays at any depth and says how many items were dropped", () => {
    const perAgent = Array.from({ length: 500 }, (_, i) => ({ id: i, path_coords: [[-79.4, 43.7]] }));
    const compacted = compactForLog({ result: { per_agent: perAgent, delta: { time_saved_min: 3.2 } } });

    expect(compacted.result.per_agent).toHaveLength(MAX_ARRAY_ITEMS_KEPT + 1);
    expect(compacted.result.per_agent[MAX_ARRAY_ITEMS_KEPT]).toBe(`…(+${500 - MAX_ARRAY_ITEMS_KEPT} more items)`);
    expect(compacted.result.per_agent[0]).toEqual({ id: 0, path_coords: [[-79.4, 43.7]] });
    expect(compacted.result.delta).toEqual({ time_saved_min: 3.2 });
  });

  it("cuts long strings and leaves small values (and the original) untouched", () => {
    const longText = "x".repeat(MAX_STRING_CHARS_KEPT + 5);
    const original = { narrative: longText, layers: [{ id: "population", on: true }], n: 3, ok: false, none: null };
    const compacted = compactForLog(original);

    expect(compacted.narrative).toBe(`${"x".repeat(MAX_STRING_CHARS_KEPT)}…(+5 chars)`);
    expect(compacted.layers).toEqual([{ id: "population", on: true }]);
    expect(compacted.n).toBe(3);
    expect(compacted.ok).toBe(false);
    expect(compacted.none).toBeNull();
    expect(original.narrative).toBe(longText); // a copy, not an in-place edit
  });
});

describe("resolveTurns", () => {
  const ui = { v: 1, layers: [{ id: "population", on: true }] };
  const routes = [{ id: "custom-1", name: "X", type: "subway", stops: [] }];

  it("turns a one-message input into one turn", () => {
    expect(resolveTurns({ message: "hi", networkRoutes: routes, ui })).toEqual([
      { message: "hi", networkRoutes: routes, ui },
    ]);
  });

  it("lets later turns inherit networkRoutes and ui, like a browser resending its map state", () => {
    const otherUi = { v: 1, layers: [] };
    const turns = resolveTurns({
      turns: [{ message: "one", networkRoutes: routes, ui }, { message: "two" }, { message: "three", ui: otherUi }],
    });
    expect(turns).toEqual([
      { message: "one", networkRoutes: routes, ui },
      { message: "two", networkRoutes: routes, ui },
      { message: "three", networkRoutes: routes, ui: otherUi },
    ]);
  });

  it("uses item-level ui / networkRoutes as the starting values for multi-turn input", () => {
    const turns = resolveTurns({ ui, turns: [{ message: "one" }, { message: "two" }] });
    expect(turns.map((turn) => turn.ui)).toEqual([ui, ui]);
  });
});

describe("buildRequestBody", () => {
  it("speaks the stateless protocol: history instead of assistantId / threadId", () => {
    const history = [{ role: "user", content: "earlier" }];
    const body = buildRequestBody({ message: "now", history, benchmarkRunId: "run-1" });
    expect(body).toEqual({
      message: "now",
      mapTools: true,
      networkRoutes: undefined,
      ui: undefined,
      history,
      benchmarkRunId: "run-1",
      provider: undefined,
    });
    expect(body).not.toHaveProperty("assistantId");
    expect(body).not.toHaveProperty("threadId");
  });

  it("leaves out an empty networkRoutes (= the default network) but sends a real one", () => {
    const sentEmpty = JSON.parse(JSON.stringify(buildRequestBody({ message: "m", networkRoutes: [] })));
    expect(sentEmpty).not.toHaveProperty("networkRoutes");
    expect(sentEmpty.history).toEqual([]); // always an array

    const routes = [{ id: "custom-1", name: "X", type: "subway", stops: [{ name: "A", coords: [-79.3, 43.7] }] }];
    expect(buildRequestBody({ message: "m", networkRoutes: routes }).networkRoutes).toBe(routes);
  });

  it("passes the ui snapshot and provider through when given", () => {
    const ui = { v: 1, layers: [] };
    const body = buildRequestBody({ message: "m", ui, provider: "gemini" });
    expect(body.ui).toBe(ui);
    expect(body.provider).toBe("gemini");
  });
});
