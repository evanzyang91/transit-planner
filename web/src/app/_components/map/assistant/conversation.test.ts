import { describe, expect, it, vi } from "vitest";
import {
  conversationReducer,
  createConversationStore,
  getPendingDrafts,
  getRetryableTurn,
  INITIAL_CONVERSATION,
  type ConversationAction,
  type ConversationState,
} from "./conversation";
import type { DraftLine } from "~/lib/map-assistant-protocol";

const READY: ConversationState = { ...INITIAL_CONVERSATION, hydrated: true };

function run(actions: ConversationAction[], start: ConversationState = READY): ConversationState {
  return actions.reduce(conversationReducer, start);
}

function started(turnId = "t1", userText = "Where are the gaps?"): ConversationAction {
  return { type: "turnStarted", turnId, userText, userMessageId: `u-${turnId}`, assistantMessageId: `a-${turnId}`, now: 1 };
}

function assistantOf(state: ConversationState, turnId = "t1") {
  const m = state.messages.find((x) => x.role === "assistant" && x.turnId === turnId);
  if (m?.role !== "assistant") throw new Error("no assistant message");
  return m;
}

const DRAFT: DraftLine = {
  draftId: "d1",
  name: "Eglinton East LRT",
  type: "lrt",
  color: "#14b8a6",
  stops: [
    { name: "Kennedy", coords: [-79.264, 43.732] },
    { name: "UTSC", coords: [-79.186, 43.784] },
  ],
  stats: { lengthKm: 9.1, stopCount: 2, avgSpacingKm: 9.1 },
};

describe("conversationReducer", () => {
  it("starts a turn with the user's message and an empty streaming answer", () => {
    const state = run([started()]);
    expect(state.activeTurnId).toBe("t1");
    expect(state.messages).toEqual([
      { id: "u-t1", role: "user", turnId: "t1", text: "Where are the gaps?", createdAt: 1 },
      { id: "a-t1", role: "assistant", turnId: "t1", text: "", status: "streaming", steps: [], drafts: [], createdAt: 1 },
    ]);
  });

  it("refuses a second turn while one is streaming", () => {
    const state = run([started("t1"), started("t2")]);
    expect(state.messages).toHaveLength(2);
    expect(state.activeTurnId).toBe("t1");
  });

  it("upserts progress steps by id", () => {
    const state = run([
      started(),
      { type: "stepUpserted", turnId: "t1", step: { id: "s1", kind: "status", tool: "rank_service_areas", label: "Ranking service areas", state: "running" } },
      { type: "stepUpserted", turnId: "t1", step: { id: "s2", kind: "status", label: "Measuring population", state: "running" } },
      { type: "stepUpserted", turnId: "t1", step: { id: "s1", kind: "status", label: "Ranking service areas", state: "done" } },
    ]);
    expect(assistantOf(state).steps.map((s) => [s.id, s.state])).toEqual([
      ["s1", "done"],
      ["s2", "running"],
    ]);
  });

  it("moves narration into a dim note on text_reset", () => {
    const state = run([
      started(),
      { type: "textFlushed", turnId: "t1", text: "Let me check Scarborough…" },
      { type: "textReset", turnId: "t1", noteId: "n1", note: "Let me check Scarborough…" },
      { type: "textFlushed", turnId: "t1", text: "Three gaps are shaded." },
    ]);
    const answer = assistantOf(state);
    expect(answer.text).toBe("Three gaps are shaded.");
    expect(answer.steps).toEqual([{ id: "n1", kind: "note", label: "Let me check Scarborough…", state: "done" }]);
  });

  it("ignores events for a turn that is not active (late events after Stop)", () => {
    const stopped = run([started(), { type: "turnFinished", turnId: "t1", outcome: "stopped", finalText: "Half" }]);
    const after = run(
      [
        { type: "textFlushed", turnId: "t1", text: "Half and more" },
        { type: "stepUpserted", turnId: "t1", step: { id: "s9", kind: "status", label: "x", state: "running" } },
        { type: "draftProposed", turnId: "t1", draft: DRAFT },
        { type: "transcriptReceived", turnId: "t1", messages: [{ role: "user", content: "zzz" }] },
      ],
      stopped,
    );
    expect(after).toBe(stopped); // nothing changed at all
  });

  it("finishes a turn: marks running steps and keeps the server transcript", () => {
    const serverTurn = [
      { role: "user" as const, content: "Where are the gaps?" },
      { role: "assistant" as const, content: "Three gaps." },
    ];
    const state = run([
      started(),
      { type: "stepUpserted", turnId: "t1", step: { id: "s1", kind: "status", label: "Ranking", state: "running" } },
      { type: "transcriptReceived", turnId: "t1", messages: serverTurn },
      { type: "turnFinished", turnId: "t1", outcome: "done", finalText: "Three gaps." },
    ]);
    expect(state.activeTurnId).toBeNull();
    expect(assistantOf(state)).toMatchObject({ status: "done", text: "Three gaps.", steps: [{ state: "done" }] });
    expect(state.transcript).toEqual([{ turnId: "t1", messages: serverTurn }]);
  });

  it("records a local transcript when the user stops before the server's turn event", () => {
    const state = run([
      started(),
      { type: "stepUpserted", turnId: "t1", step: { id: "s1", kind: "status", label: "Ranking", state: "running" } },
      { type: "turnFinished", turnId: "t1", outcome: "stopped", finalText: "" },
    ]);
    expect(assistantOf(state)).toMatchObject({ status: "stopped", steps: [{ state: "stopped" }] });
    expect(state.transcript).toEqual([
      {
        turnId: "t1",
        messages: [
          { role: "user", content: "Where are the gaps?" },
          { role: "assistant", content: "(stopped by the user)" },
        ],
      },
    ]);
  });

  it("keeps partial text and the error on a failed turn", () => {
    const state = run([
      started(),
      { type: "turnFinished", turnId: "t1", outcome: "error", finalText: "Partial", error: { message: "Overloaded", retryable: true } },
    ]);
    expect(assistantOf(state)).toMatchObject({ status: "error", text: "Partial", error: { message: "Overloaded", retryable: true } });
    expect(state.transcript[0]?.messages[1]?.content).toContain("Partial");
  });

  it("stores a propose_line draft as pending, then records the user's choice once", () => {
    let state = run([started(), { type: "draftProposed", turnId: "t1", draft: DRAFT }]);
    state = run([{ type: "turnFinished", turnId: "t1", outcome: "done", finalText: "Here's a draft." }], state);
    expect(getPendingDrafts(state)).toEqual([{ turnId: "t1", draftId: "d1" }]);

    state = run([{ type: "draftDecided", turnId: "t1", draftId: "d1", decision: { state: "failed", error: "Map not ready" } }], state);
    expect(assistantOf(state).drafts[0]?.decision).toEqual({ state: "failed", error: "Map not ready" });

    state = run([{ type: "draftDecided", turnId: "t1", draftId: "d1", decision: { state: "added", routeId: "custom-3" } }], state);
    const final = run([{ type: "draftDecided", turnId: "t1", draftId: "d1", decision: { state: "discarded" } }], state);
    expect(final).toBe(state); // "added" is final
    expect(getPendingDrafts(final)).toEqual([]);
  });

  it("removes a whole failed turn for Retry, but never the active one", () => {
    const failed = run([
      started(),
      { type: "turnFinished", turnId: "t1", outcome: "error", finalText: "", error: { message: "x", retryable: true } },
    ]);
    expect(getRetryableTurn(failed)).toEqual({ turnId: "t1", userText: "Where are the gaps?" });
    const removed = run([{ type: "turnRemoved", turnId: "t1" }], failed);
    expect(removed.messages).toEqual([]);
    expect(removed.transcript).toEqual([]);

    const streaming = run([started("t2")]);
    expect(run([{ type: "turnRemoved", turnId: "t2" }], streaming)).toBe(streaming);
  });

  it("only offers Retry for the latest, retryable failure", () => {
    const notRetryable = run([
      started(),
      { type: "turnFinished", turnId: "t1", outcome: "error", finalText: "", error: { message: "Bad request", retryable: false } },
    ]);
    expect(getRetryableTurn(notRetryable)).toBeNull();
  });

  it("hydrates a saved chat once, without clobbering a chat already in progress", () => {
    const saved = { messages: [{ id: "u0", role: "user" as const, turnId: "t0", text: "old", createdAt: 0 }], transcript: [] };
    const fresh = run([{ type: "hydrated", conversation: saved }], INITIAL_CONVERSATION);
    expect(fresh.hydrated).toBe(true);
    expect(fresh.messages).toEqual(saved.messages);

    const busy = run([started()], INITIAL_CONVERSATION);
    const afterLoad = run([{ type: "hydrated", conversation: saved }], busy);
    expect(afterLoad.messages).toEqual(busy.messages);
    expect(afterLoad.hydrated).toBe(true);
  });

  it("clears everything on New chat", () => {
    const state = run([started(), { type: "cleared" }]);
    expect(state).toEqual({ ...READY, messages: [], transcript: [], activeTurnId: null });
  });
});

describe("createConversationStore", () => {
  it("notifies subscribers only when the state actually changes", () => {
    const store = createConversationStore(READY);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.dispatch(started());
    store.dispatch(started("t2")); // refused → same state → no notification
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.dispatch({ type: "cleared" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().messages).toEqual([]);
  });
});
