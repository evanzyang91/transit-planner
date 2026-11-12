import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatEngine, type MapAssistantBridge } from "./chat-engine";
import { createConversationStore, INITIAL_CONVERSATION, type ConversationState } from "./conversation";
import type { AnnotationInput } from "~/lib/ai-map-tools-client";
import type { DraftLine, MapChatRequest } from "~/lib/map-assistant-protocol";

// ── Test harness ─────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function sseBody(events: unknown[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

function sseResponse(events: unknown[]): Response {
  return new Response(sseBody(events), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** A response we can feed event by event, to test Stop / New chat mid-answer. */
function liveResponse() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    response: new Response(stream, { status: 200 }),
    push(event: unknown) {
      controller.enqueue(encoder.encode(sseBody([event])));
    },
  };
}

const DRAFT: DraftLine = {
  draftId: "draft-1",
  name: "Eglinton East LRT",
  type: "lrt",
  color: "#14b8a6",
  stops: [
    { name: "Kennedy", coords: [-79.264, 43.732] },
    { name: "UTSC", coords: [-79.186, 43.784] },
  ],
  stats: { lengthKm: 9.1, stopCount: 2, avgSpacingKm: 9.1, estCostBillions: 1.2, populationServed: 85000 },
};

type QueuedReply = Response | Error;

function setup(replies: QueuedReply[]) {
  const store = createConversationStore({ ...INITIAL_CONVERSATION, hydrated: true });
  const added: AnnotationInput[] = [];
  const annotations = {
    add: vi.fn((a: AnnotationInput) => {
      added.push(a);
      return `ann-${added.length}`;
    }),
    clearAll: vi.fn(),
    clearTurn: vi.fn(),
  };
  const bridge = {
    getNetworkRoutes: vi.fn(() => [{ id: "line-1", name: "Line 1", type: "subway", stops: [] }]),
    getUiSnapshot: vi.fn(() => ({ v: 1 as const, layers: [{ id: "population" as const, on: true }] })),
    onAppAction: vi.fn(),
    commitDraftLine: vi.fn((): ReturnType<MapAssistantBridge["commitDraftLine"]> => ({ ok: true, routeId: "custom-1" })),
    discardDraftLine: vi.fn(),
  } satisfies MapAssistantBridge;

  const requests: MapChatRequest[] = [];
  const queue = [...replies];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    requests.push(JSON.parse(init?.body as string) as MapChatRequest); // the engine always sends a JSON string
    const next = queue.shift();
    if (!next) throw new Error("test: no reply queued");
    if (next instanceof Error) throw next;
    return next;
  });

  // Animation frames run only when the test says so.
  const frames = new Map<number, () => void>();
  let nextFrame = 1;
  let nextId = 1;
  const track = vi.fn();

  const engine = createChatEngine({
    store,
    getBridge: () => bridge,
    getAnnotations: () => annotations,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    requestFrame: (callback) => {
      const handle = nextFrame++;
      frames.set(handle, callback);
      return handle;
    },
    cancelFrame: (handle) => frames.delete(handle),
    track,
    readProvider: () => "anthropic",
    newId: () => `id-${nextId++}`,
  });

  function runFrames() {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback());
  }

  /** Waits until no turn is streaming. */
  async function settled(): Promise<ConversationState> {
    await vi.waitFor(() => expect(store.getState().activeTurnId).toBeNull());
    return store.getState();
  }

  function lastAssistant() {
    const last = store.getState().messages.at(-1);
    if (last?.role !== "assistant") throw new Error("no assistant message");
    return last;
  }

  return { store, engine, annotations, added, bridge, requests, fetchImpl, frames, runFrames, settled, lastAssistant, track };
}

afterEach(() => {
  vi.restoreAllMocks();
});

const SERVER_TURN = [
  { role: "user", content: "Where are the gaps?" },
  { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "rank_service_areas", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: '{"areas":3}' }] },
  { role: "assistant", content: "Three gaps are shaded." },
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe("chat engine — a full turn", () => {
  it("sends the request, applies every event and remembers the server transcript", async () => {
    const t = setup([
      sseResponse([
        { type: "start", model: "claude-haiku-5-5" },
        { type: "status", id: "s1", tool: "rank_service_areas", label: "Ranking service areas", state: "running" },
        { type: "text", delta: "Let me check " },
        { type: "text", delta: "Scarborough…" },
        { type: "text_reset", note: "Let me check Scarborough…" },
        { type: "status", id: "s1", tool: "rank_service_areas", label: "Ranking service areas", state: "done" },
        { type: "tool_call", name: "highlight_area", args: { label: "Malvern gap", polygon: [[0, 0], [1, 0], [1, 1]] } },
        { type: "tool_call", name: "set_map_layers", args: { layers: [{ id: "transitDesert", on: true }] } },
        { type: "tool_call", name: "propose_line", args: DRAFT },
        { type: "text", delta: "Three gaps " },
        { type: "text", delta: "are shaded." },
        { type: "turn", messages: SERVER_TURN },
        { type: "done" },
      ]),
    ]);

    t.engine.actions.send("  Where are the gaps?  ");
    const state = await t.settled();

    // Request body follows MapChatRequest.
    expect(t.requests).toHaveLength(1);
    expect(t.requests[0]).toEqual({
      message: "Where are the gaps?",
      history: [],
      provider: "anthropic",
      mapTools: true,
      networkRoutes: [{ id: "line-1", name: "Line 1", type: "subway", stops: [] }],
      ui: { v: 1, layers: [{ id: "population", on: true }] },
    });

    const answer = t.lastAssistant();
    expect(answer.status).toBe("done");
    expect(answer.text).toBe("Three gaps are shaded.");
    // The narration became a dim note; the status step finished.
    expect(answer.steps.map((s) => [s.kind, s.label, s.state])).toEqual([
      ["status", "Ranking service areas", "done"],
      ["note", "Let me check Scarborough…", "done"],
    ]);

    // Drawing → annotation keyed to the turn; app action → bridge; draft → card.
    expect(t.added).toEqual([
      expect.objectContaining({ kind: "highlight", label: "Malvern gap", turnId: answer.turnId }),
    ]);
    expect(t.bridge.onAppAction).toHaveBeenCalledWith(
      { name: "set_map_layers", args: { layers: [{ id: "transitDesert", on: true }] } },
      answer.turnId,
    );
    expect(t.bridge.onAppAction).toHaveBeenCalledWith({ name: "propose_line", args: DRAFT }, answer.turnId);
    expect(answer.drafts).toEqual([{ draft: DRAFT, decision: { state: "pending" } }]);

    expect(state.transcript).toEqual([{ turnId: answer.turnId, messages: SERVER_TURN }]);
    expect(t.track).toHaveBeenCalledWith("AI Response Received", expect.objectContaining({ model: "claude-haiku-5-5" }));
  });

  it("sends the earlier turns back as history on the next message", async () => {
    const t = setup([
      sseResponse([{ type: "text", delta: "Three gaps are shaded." }, { type: "turn", messages: SERVER_TURN }, { type: "done" }]),
      sseResponse([{ type: "text", delta: "Malvern." }, { type: "turn", messages: [{ role: "user", content: "Which is biggest?" }, { role: "assistant", content: "Malvern." }] }, { type: "done" }]),
    ]);
    t.engine.actions.send("Where are the gaps?");
    await t.settled();
    t.engine.actions.send("Which is biggest?");
    await t.settled();
    expect(t.requests[1]?.history).toEqual(SERVER_TURN);
  });

  it("batches streamed text into one store update per animation frame", async () => {
    const live = liveResponse();
    const t = setup([live.response]);
    t.engine.actions.send("hi");
    await vi.waitFor(() => expect(t.fetchImpl).toHaveBeenCalled());
    live.push({ type: "text", delta: "Hel" });
    live.push({ type: "text", delta: "lo" });
    await vi.waitFor(() => expect(t.frames.size).toBe(1)); // one frame for both deltas
    expect(t.lastAssistant().text).toBe(""); // nothing rendered until the frame runs
    t.runFrames();
    expect(t.lastAssistant().text).toBe("Hello");
    t.engine.actions.stop();
  });

  it("a text_reset without a note removes the text and shows nothing (e.g. a refused reply)", async () => {
    const t = setup([
      sseResponse([
        { type: "text", delta: "Sure, here is how to" },
        { type: "text_reset" },
        { type: "text", delta: "I can't help with that." },
        { type: "turn", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "I can't help with that." }] },
        { type: "done" },
      ]),
    ]);
    t.engine.actions.send("q");
    await t.settled();
    expect(t.lastAssistant()).toMatchObject({ text: "I can't help with that.", steps: [] });
  });

  it("only allows one request at a time", async () => {
    const live = liveResponse();
    const t = setup([live.response]);
    t.engine.actions.send("first");
    t.engine.actions.send("second");
    await vi.waitFor(() => expect(t.fetchImpl).toHaveBeenCalledTimes(1));
    expect(t.store.getState().messages.filter((m) => m.role === "user")).toHaveLength(1);
    t.engine.actions.stop();
  });

  it("warns about unknown events and tool calls instead of crashing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined); // keep test output quiet
    const t = setup([
      sseResponse([
        { type: "mystery" },
        { type: "tool_call", name: "launch_rockets", args: {} },
        { type: "tool_call", name: "open_panel", args: { panel: "kitchen" } }, // invalid args
        { type: "text", delta: "ok" },
        { type: "turn", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "ok" }] },
        { type: "done" },
      ]),
    ]);
    t.engine.actions.send("q");
    await t.settled();
    expect(t.lastAssistant()).toMatchObject({ status: "done", text: "ok" });
    expect(t.bridge.onAppAction).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(3);
  });
});

describe("chat engine — errors and retry", () => {
  it("keeps partial text, shows the server's error, and still stores its transcript", async () => {
    const failedTurn = [{ role: "user", content: "q" }, { role: "assistant", content: "Partial" }];
    const t = setup([
      sseResponse([
        { type: "text", delta: "Partial" },
        { type: "error", error: "The model is overloaded.", retryable: true },
        { type: "turn", messages: failedTurn },
        { type: "done" },
      ]),
    ]);
    t.engine.actions.send("q");
    const state = await t.settled();
    expect(t.lastAssistant()).toMatchObject({
      status: "error",
      text: "Partial",
      error: { message: "The model is overloaded.", retryable: true },
    });
    expect(state.transcript[0]?.messages).toEqual(failedTurn);
  });

  it("reads the JSON { error } body of a non-OK response", async () => {
    const t = setup([
      new Response(JSON.stringify({ error: "Upstream timeout" }), { status: 502 }),
      new Response(JSON.stringify({ error: "message is required" }), { status: 400 }),
    ]);
    t.engine.actions.send("q1");
    await t.settled();
    expect(t.lastAssistant().error).toEqual({ message: "Upstream timeout", retryable: true });

    t.engine.actions.send("q2");
    await t.settled();
    expect(t.lastAssistant().error?.retryable).toBe(false);
    expect(t.lastAssistant().error?.message).toContain("message is required");
  });

  it("reports a network failure as retryable", async () => {
    const t = setup([new TypeError("Failed to fetch")]);
    t.engine.actions.send("q");
    await t.settled();
    expect(t.lastAssistant()).toMatchObject({ status: "error", error: { retryable: true } });
  });

  it("treats a stream that ends without `done` or `turn` as cut off", async () => {
    const t = setup([sseResponse([{ type: "text", delta: "Half" }])]);
    t.engine.actions.send("q");
    await t.settled();
    expect(t.lastAssistant()).toMatchObject({ status: "error", text: "Half", error: { retryable: true } });
  });

  it("retry() drops the failed turn (transcript + shapes) and resends the same message", async () => {
    const t = setup([
      sseResponse([
        { type: "tool_call", name: "drop_pin", args: { lat: 43.7, lng: -79.4, note: "Here" } },
        { type: "error", error: "Overloaded", retryable: true },
        { type: "done" },
      ]),
      sseResponse([{ type: "text", delta: "Fixed." }, { type: "turn", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "Fixed." }] }, { type: "done" }]),
    ]);
    t.engine.actions.send("q");
    const failed = await t.settled();
    const failedTurnId = failed.messages[0]!.turnId;

    t.engine.actions.retry();
    const after = await t.settled();

    expect(t.annotations.clearTurn).toHaveBeenCalledWith(failedTurnId);
    expect(t.requests[1]).toMatchObject({ message: "q", history: [] }); // failed turn not resent
    expect(after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(t.lastAssistant()).toMatchObject({ status: "done", text: "Fixed." });
  });
});

describe("chat engine — Stop and New chat", () => {
  it("stop() keeps the partial answer, records a local transcript and ignores late events", async () => {
    const live = liveResponse();
    const t = setup([live.response]);
    t.engine.actions.send("Explain the heatmap");
    await vi.waitFor(() => expect(t.fetchImpl).toHaveBeenCalled());
    live.push({ type: "text", delta: "The heatmap shows" });
    await vi.waitFor(() => expect(t.frames.size).toBe(1));

    t.engine.actions.stop();
    const state = t.store.getState();
    expect(state.activeTurnId).toBeNull();
    expect(t.lastAssistant()).toMatchObject({ status: "stopped", text: "The heatmap shows" });
    expect(state.transcript[0]?.messages).toEqual([
      { role: "user", content: "Explain the heatmap" },
      { role: "assistant", content: "The heatmap shows\n\n(stopped by the user)" },
    ]);

    // Anything the server still sends is ignored.
    const before = t.store.getState();
    try {
      live.push({ type: "tool_call", name: "drop_pin", args: { lat: 1, lng: 2, note: "late" } });
    } catch {
      // the stream may already be cancelled — that's fine too
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(t.store.getState()).toBe(before);
    expect(t.added).toEqual([]);
  });

  it("newChat() aborts, clears the chat and the map findings, and discards pending drafts", async () => {
    const live = liveResponse();
    const t = setup([live.response]);
    t.engine.actions.send("Draft a line");
    await vi.waitFor(() => expect(t.fetchImpl).toHaveBeenCalled());
    live.push({ type: "tool_call", name: "propose_line", args: DRAFT });
    await vi.waitFor(() => expect(t.lastAssistant().drafts).toHaveLength(1));

    t.engine.actions.newChat();
    expect(t.store.getState()).toMatchObject({ messages: [], transcript: [], activeTurnId: null });
    expect(t.annotations.clearAll).toHaveBeenCalledTimes(1);
    expect(t.bridge.discardDraftLine).toHaveBeenCalledWith("draft-1");
  });
});

describe("chat engine — draft confirm card", () => {
  async function withDraft() {
    const t = setup([
      sseResponse([
        { type: "tool_call", name: "propose_line", args: DRAFT },
        { type: "text", delta: "Here's a draft." },
        { type: "turn", messages: [{ role: "user", content: "Draft" }, { role: "assistant", content: "Here's a draft." }] },
        { type: "done" },
      ]),
    ]);
    t.engine.actions.send("Draft");
    await t.settled();
    return t;
  }

  it("adds the line once, even on a double click", async () => {
    const t = await withDraft();
    const turnId = t.lastAssistant().turnId;
    t.engine.actions.decideDraft(turnId, "draft-1", "add");
    t.engine.actions.decideDraft(turnId, "draft-1", "add");
    expect(t.bridge.commitDraftLine).toHaveBeenCalledTimes(1);
    expect(t.lastAssistant().drafts[0]?.decision).toEqual({ state: "added", routeId: "custom-1" });
  });

  it("shows the map's error and lets the user try again", async () => {
    const t = await withDraft();
    const turnId = t.lastAssistant().turnId;
    t.bridge.commitDraftLine.mockReturnValueOnce({ ok: false, error: "A line with that name exists." });
    t.engine.actions.decideDraft(turnId, "draft-1", "add");
    expect(t.lastAssistant().drafts[0]?.decision).toEqual({ state: "failed", error: "A line with that name exists." });
    t.engine.actions.decideDraft(turnId, "draft-1", "add");
    expect(t.lastAssistant().drafts[0]?.decision).toEqual({ state: "added", routeId: "custom-1" });
  });

  it("discard removes the preview and is final", async () => {
    const t = await withDraft();
    const turnId = t.lastAssistant().turnId;
    t.engine.actions.decideDraft(turnId, "draft-1", "discard");
    t.engine.actions.decideDraft(turnId, "draft-1", "add");
    expect(t.bridge.discardDraftLine).toHaveBeenCalledWith("draft-1");
    expect(t.bridge.commitDraftLine).not.toHaveBeenCalled();
    expect(t.lastAssistant().drafts[0]?.decision).toEqual({ state: "discarded" });
  });
});

describe("chat engine — leaving mid-answer", () => {
  it("snapshotIfInterrupted() returns the chat as if stopped, without changing the store", async () => {
    const live = liveResponse();
    const t = setup([live.response]);
    expect(t.engine.snapshotIfInterrupted()).toBeNull();
    t.engine.actions.send("q");
    await vi.waitFor(() => expect(t.fetchImpl).toHaveBeenCalled());
    live.push({ type: "text", delta: "Half" });
    await vi.waitFor(() => expect(t.frames.size).toBe(1));

    const snapshot = t.engine.snapshotIfInterrupted();
    expect(snapshot?.messages.at(-1)).toMatchObject({ status: "stopped", text: "Half" });
    expect(t.store.getState().activeTurnId).not.toBeNull(); // the real chat is untouched

    // dispose() (provider unmount / effects re-run) ends the turn like Stop.
    t.engine.dispose();
    expect(t.store.getState().activeTurnId).toBeNull();
    expect(t.lastAssistant()).toMatchObject({ status: "stopped", text: "Half" });
  });
});
