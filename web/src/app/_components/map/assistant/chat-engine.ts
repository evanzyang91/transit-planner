/**
 * The Ask AI "engine": sends a message, reads the streamed answer, and turns
 * each server event into a change of the conversation store, a map annotation
 * or an app action for TransitMap. No React in here — MapAssistantProvider
 * creates one engine and hands its actions to the UI.
 *
 * Why a plain factory instead of logic inside the React component?
 *  • A turn is a long async function. Everything it needs (the store, the
 *    current bridge, the in-flight request) is read at the moment it's needed,
 *    so nothing goes stale the way a captured React state value would.
 *  • The browser-only pieces (fetch, requestAnimationFrame, analytics) are
 *    passed in, so the whole flow can be unit-tested with a fake response.
 *
 * Protocol: see ~/lib/map-assistant-protocol.ts (MapChatRequest / MapChatEvent).
 */

import {
  getPendingDrafts,
  getRetryableTurn,
  conversationReducer,
  type ConversationState,
  type ConversationStore,
  type TurnOutcome,
} from "./conversation";
import { mapToolToAnnotation, type AnnotationInput } from "~/lib/ai-map-tools-client";
import { buildRequestHistory, truncateText } from "~/lib/map-assistant-history";
import {
  isAnnotationToolName,
  isAppActionName,
  parseAppAction,
  type AppAction,
  type DraftLine,
  type MapChatEvent,
  type MapChatRequest,
  type MapUiSnapshot,
} from "~/lib/map-assistant-protocol";
import { readSSE } from "~/lib/sse";

// ── Public types (re-exported by MapAssistantContext.tsx) ────────────────────

/**
 * What TransitMap gives the assistant. Registered on every render, so the
 * callbacks may close over fresh state — the engine always calls the latest.
 */
export interface MapAssistantBridge {
  /** The live routes on the map (sent as `networkRoutes`). */
  getNetworkRoutes(): unknown;
  /** What the user can see right now (sent as `ui`). */
  getUiSnapshot(): MapUiSnapshot;
  /** An app action from the assistant. Mutating ones must only OPEN a confirm UI. */
  onAppAction(action: AppAction, turnId: string): void;
  /** The user clicked "Add to map" on a draft card. */
  commitDraftLine(draft: DraftLine): { ok: true; routeId: string } | { ok: false; error: string };
  /** The user clicked "Discard" (or started a new chat): remove the draft's map preview. */
  discardDraftLine(draftId: string): void;
}

/**
 * Stable functions — they never change identity, so passing them around never
 * re-renders anything. Written as `name: (…) => …` properties (not methods)
 * because components destructure them: `const { send } = useMapAssistant()`.
 * 📖 Learn: TypeScript's "unbound method" check — a method pulled off its
 * object may lose `this`; plain function properties make clear they don't use it.
 */
export interface MapAssistantActions {
  /** Sends a message. Ignored while an answer is streaming (one request at a time). */
  send: (text: string) => void;
  /** Stops the streaming answer; keeps what arrived so far. */
  stop: () => void;
  /** Resends the last message if it failed with a retryable error. */
  retry: () => void;
  /** Stops any answer, clears the chat AND the map findings it drew. */
  newChat: () => void;
  /** The user's choice on a propose_line confirm card. */
  decideDraft: (turnId: string, draftId: string, choice: "add" | "discard") => void;
}

/** The parts of AIAnnotationsContext the engine uses. */
export interface AnnotationApi {
  add: (annotation: AnnotationInput) => string;
  clearAll: () => void;
  clearTurn: (turnId: string) => void;
}

type AnalyticsProps = Record<string, string | number | boolean | null | undefined>;

export interface ChatEngineDeps {
  store: ConversationStore;
  /** The bridge TransitMap registered most recently (null before the map mounts). */
  getBridge: () => MapAssistantBridge | null;
  getAnnotations: () => AnnotationApi;
  // ↓ Browser services, injectable for tests.
  fetchImpl?: typeof fetch;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
  track?: (event: string, props: AnalyticsProps) => void;
  readProvider?: () => "anthropic" | "gemini";
  newId?: () => string;
}

export interface ChatEngine {
  actions: MapAssistantActions;
  /**
   * The state as it would be if the streaming turn were stopped now, or null
   * when nothing is streaming. Saved when the page goes away mid-answer, so the
   * question isn't lost.
   */
  snapshotIfInterrupted(): ConversationState | null;
  /** Aborts the streaming turn (the provider is unmounting). */
  dispose(): void;
}

/** Mutable bookkeeping for the one turn that is streaming. */
interface ActiveTurn {
  turnId: string;
  userText: string;
  controller: AbortController;
  /** The answer so far. The store receives it at most once per animation frame. */
  answerText: string;
  sawTranscript: boolean;
  serverError: { message: string; retryable: boolean } | null;
  provider: "anthropic" | "gemini";
  model: string | null;
  startedAt: number;
  annotationCount: number;
  actionCount: number;
}

// ── Small helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** Settings ⚙ → AI provider writes this key (see TransitMap). */
function readProviderFromStorage(): "anthropic" | "gemini" {
  try {
    return localStorage.getItem("aiProvider") === "gemini" ? "gemini" : "anthropic";
  } catch {
    return "anthropic"; // storage blocked (private mode, sandboxed iframe)
  }
}

/**
 * The dim progress line for a text_reset, or null for none. Only the server's
 * `note` is shown: the server sends the narration itself as the note when it's
 * worth showing ("Let me check Scarborough…"), and sends NO note when the text
 * must simply disappear (e.g. a partial answer that was then refused).
 */
function noteFromReset(serverNote: unknown): string | null {
  if (typeof serverNote !== "string") return null;
  const oneLine = serverNote.replace(/\s+/g, " ").trim();
  return oneLine ? truncateText(oneLine, 160) : null;
}

/** Turns a non-2xx response into a message for the error row. The server sends JSON `{ error }`. */
async function describeHttpError(response: Response): Promise<{ message: string; retryable: boolean }> {
  let serverMessage: string | null = null;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && typeof body.error === "string" && body.error.trim()) serverMessage = body.error.trim();
  } catch {
    /* not JSON — fall back to the status code */
  }
  // 5xx, "too many requests" and timeouts can succeed on a second try; other 4xx won't.
  const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
  const base = serverMessage ?? `The assistant couldn't answer (HTTP ${response.status}).`;
  const hint = retryable ? "" : " If this keeps happening, start a new chat.";
  return { message: base + hint, retryable };
}

/** Calls into TransitMap without letting a bug there break the chat. */
function callSafely<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (error) {
    console.error(`[ask-ai] ${what} failed:`, error);
    return undefined;
  }
}

// ── The engine ───────────────────────────────────────────────────────────────

export function createChatEngine(deps: ChatEngineDeps): ChatEngine {
  const { store, getBridge, getAnnotations } = deps;
  // `fetch` must be called with the window as `this`, hence the arrow wrapper.
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const requestFrame = deps.requestFrame ?? ((callback: () => void) => requestAnimationFrame(callback));
  const cancelFrame = deps.cancelFrame ?? ((handle: number) => cancelAnimationFrame(handle));
  const track =
    deps.track ??
    (() => {
      /* no analytics wired up (e.g. in tests) */
    });
  const readProvider = deps.readProvider ?? readProviderFromStorage;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  /** The turn that is streaming. Also the "turn token": events for any other turn are ignored. */
  let activeTurn: ActiveTurn | null = null;
  let flushFrame: number | null = null;

  // ── Text batching ──
  // Tokens arrive far faster than the screen refreshes. Collect them on the
  // turn and push them into React at most once per frame.
  // 📖 Learn: requestAnimationFrame runs a callback right before the next paint.
  function cancelScheduledFlush() {
    if (flushFrame !== null) {
      cancelFrame(flushFrame);
      flushFrame = null;
    }
  }

  function scheduleTextFlush() {
    if (flushFrame !== null) return; // already scheduled for this frame
    flushFrame = requestFrame(() => {
      flushFrame = null;
      if (activeTurn) store.dispatch({ type: "textFlushed", turnId: activeTurn.turnId, text: activeTurn.answerText });
    });
  }

  // ── Ending a turn (exactly once) ──
  function finishTurn(turn: ActiveTurn, outcome: TurnOutcome, error?: { message: string; retryable: boolean }) {
    if (activeTurn !== turn) return; // already finished (e.g. Stop, then the stream closed)
    activeTurn = null;
    cancelScheduledFlush();
    store.dispatch({ type: "turnFinished", turnId: turn.turnId, outcome, finalText: turn.answerText, error });

    const durationMs = Math.round(performance.now() - turn.startedAt);
    if (outcome === "done") {
      track("AI Response Received", {
        provider: turn.provider,
        model: turn.model,
        response_length: turn.answerText.length,
        annotation_count: turn.annotationCount,
        app_action_count: turn.actionCount,
        duration_ms: durationMs,
        streaming: true,
      });
    } else if (outcome === "error") {
      track("AI Response Failed", {
        provider: turn.provider,
        error: error?.message,
        retryable: error?.retryable,
        duration_ms: durationMs,
        streaming: true,
      });
    } else {
      track("AI Response Stopped", { provider: turn.provider, duration_ms: durationMs });
    }
  }

  // ── Drawing tools and app actions ──
  function handleToolCall(turn: ActiveTurn, name: unknown, args: unknown) {
    if (typeof name !== "string" || !isRecord(args)) {
      console.warn("[ask-ai] Ignored a malformed tool_call:", name, args);
      return;
    }
    if (isAnnotationToolName(name)) {
      const annotation = mapToolToAnnotation(name, args, turn.turnId);
      if (annotation) {
        getAnnotations().add(annotation);
        turn.annotationCount += 1;
      }
      return;
    }
    if (isAppActionName(name)) {
      // The server validated the args already; this is defence in depth so a
      // malformed event can never crash TransitMap.
      const action = parseAppAction(name, args);
      if (!action) {
        console.warn(`[ask-ai] Ignored an invalid "${name}" action:`, args);
        return;
      }
      turn.actionCount += 1;
      // Keep a proposed line on the message too, for its confirm card
      // (human-in-the-loop: nothing is added until the user clicks "Add to map").
      if (action.name === "propose_line") {
        store.dispatch({ type: "draftProposed", turnId: turn.turnId, draft: action.args });
      }
      const bridge = getBridge();
      if (!bridge) {
        console.warn(`[ask-ai] The map isn't ready, so "${name}" was not applied.`);
        return;
      }
      callSafely(`onAppAction(${name})`, () => bridge.onAppAction(action, turn.turnId));
      return;
    }
    console.warn(`[ask-ai] Ignored an unknown tool_call "${name}".`);
  }

  // ── One SSE event ──
  function handleEvent(turn: ActiveTurn, raw: unknown) {
    if (activeTurn !== turn) return; // a late event from a stopped or replaced turn
    if (!isRecord(raw) || typeof raw.type !== "string") {
      console.warn("[ask-ai] Ignored an event without a type:", raw);
      return;
    }
    const event = raw as MapChatEvent;
    switch (event.type) {
      case "start":
        turn.model = typeof event.model === "string" ? event.model : null;
        return;

      case "status": {
        if (typeof event.id !== "string" || typeof event.label !== "string") {
          console.warn("[ask-ai] Ignored a malformed status event:", event);
          return;
        }
        const state = event.state === "done" || event.state === "error" ? event.state : "running";
        store.dispatch({
          type: "stepUpserted",
          turnId: turn.turnId,
          step: { id: event.id, kind: "status", label: event.label, tool: event.tool, state },
        });
        return;
      }

      case "text":
        if (typeof event.delta === "string" && event.delta !== "") {
          turn.answerText += event.delta;
          scheduleTextFlush();
        }
        return;

      case "text_reset": {
        // What streamed so far wasn't the answer (mid-step narration, or a refused reply).
        const note = noteFromReset(event.note);
        turn.answerText = "";
        cancelScheduledFlush();
        store.dispatch({ type: "textReset", turnId: turn.turnId, noteId: newId(), note });
        return;
      }

      case "tool_call":
        handleToolCall(turn, event.name, event.args);
        return;

      case "turn":
        if (Array.isArray(event.messages)) {
          store.dispatch({ type: "transcriptReceived", turnId: turn.turnId, messages: event.messages });
          turn.sawTranscript = true;
        }
        return;

      case "error":
        // Don't finish yet: the server still sends `turn` (so the failed turn
        // is remembered) and then `done`.
        turn.serverError = {
          message: typeof event.error === "string" && event.error.trim() ? event.error : "Something went wrong.",
          retryable: event.retryable !== false, // offer Retry unless the server says it's pointless
        };
        return;

      case "done":
        // Finish now rather than when the connection closes — the server may
        // still be flushing traces. Anything after this is ignored.
        if (turn.serverError) finishTurn(turn, "error", turn.serverError);
        else finishTurn(turn, "done");
        return;

      default:
        console.warn("[ask-ai] Ignored an unknown event type:", (event as { type: string }).type);
    }
  }

  // ── One request/response round trip ──
  async function runTurn(text: string): Promise<void> {
    const provider = readProvider();
    const turn: ActiveTurn = {
      turnId: newId(),
      userText: text,
      controller: new AbortController(),
      answerText: "",
      sawTranscript: false,
      serverError: null,
      provider,
      model: null,
      startedAt: performance.now(),
      annotationCount: 0,
      actionCount: 0,
    };

    // Built BEFORE this turn is added: the history is everything earlier.
    const history = buildRequestHistory(store.getState().transcript);
    activeTurn = turn;
    store.dispatch({
      type: "turnStarted",
      turnId: turn.turnId,
      userText: text,
      userMessageId: newId(),
      assistantMessageId: newId(),
      now: Date.now(),
    });

    const request: MapChatRequest = { message: text, history, provider, mapTools: true };
    const bridge = getBridge();
    if (bridge) {
      const routes = callSafely("getNetworkRoutes", () => bridge.getNetworkRoutes());
      if (routes !== undefined) request.networkRoutes = routes;
      const ui = callSafely("getUiSnapshot", () => bridge.getUiSnapshot());
      if (ui) request.ui = ui;
    }

    track("AI Message Sent", {
      message_length: text.length,
      history_messages: history.length,
      provider,
      map_tools: true,
      streaming: true,
      has_ui_snapshot: Boolean(request.ui),
    });

    let response: Response;
    try {
      response = await fetchImpl("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: turn.controller.signal,
      });
    } catch (error) {
      if (!isAbortError(error)) {
        finishTurn(turn, "error", {
          message: "Couldn't reach the assistant. Check your connection and try again.",
          retryable: true,
        });
      }
      return;
    }
    if (activeTurn !== turn) return;

    if (!response.ok) {
      const failure = await describeHttpError(response);
      finishTurn(turn, "error", failure); // no-op if the user pressed Stop meanwhile
      return;
    }

    try {
      await readSSE(response, (data) => handleEvent(turn, data), { signal: turn.controller.signal });
    } catch (error) {
      if (!isAbortError(error)) {
        console.error("[ask-ai] Reading the answer failed:", error);
        finishTurn(turn, "error", { message: "The connection dropped before the answer finished.", retryable: true });
      }
      return;
    }

    // The stream closed. Normally `done` already finished the turn and these
    // do nothing; otherwise the server stopped early.
    if (turn.serverError) finishTurn(turn, "error", turn.serverError);
    else if (turn.sawTranscript) finishTurn(turn, "done");
    else finishTurn(turn, "error", { message: "The answer was cut off before it finished.", retryable: true });
  }

  function discardDraftPreview(draftId: string) {
    const bridge = getBridge();
    if (bridge) callSafely("discardDraftLine", () => bridge.discardDraftLine(draftId));
  }

  // ── Public actions ──
  function send(rawText: string) {
    const text = rawText.trim();
    if (!text) return;
    if (activeTurn) return; // one request at a time
    runTurn(text).catch((error: unknown) => console.error("[ask-ai] Unexpected error:", error));
  }

  function stop() {
    const turn = activeTurn;
    if (!turn) return;
    finishTurn(turn, "stopped"); // first: from here on, late events are ignored
    turn.controller.abort();
  }

  function retry() {
    if (activeTurn) return;
    const target = getRetryableTurn(store.getState());
    if (!target) return;
    // The retry redraws whatever the failed attempt drew — remove the
    // leftovers (and draft previews) so nothing appears twice.
    getAnnotations().clearTurn(target.turnId);
    for (const pending of getPendingDrafts(store.getState())) {
      if (pending.turnId === target.turnId) discardDraftPreview(pending.draftId);
    }
    store.dispatch({ type: "turnRemoved", turnId: target.turnId });
    track("AI Message Retried", {});
    send(target.userText);
  }

  function newChat() {
    const turn = activeTurn;
    if (turn) {
      activeTurn = null; // late events from it are now ignored
      cancelScheduledFlush();
      turn.controller.abort();
    }
    // A pending draft's preview would otherwise stay on the map with no card left to confirm it.
    for (const pending of getPendingDrafts(store.getState())) discardDraftPreview(pending.draftId);
    store.dispatch({ type: "cleared" });
    // Same as the old "New chat" button: the map findings this chat drew go too.
    getAnnotations().clearAll();
  }

  function decideDraft(turnId: string, draftId: string, choice: "add" | "discard") {
    const message = store.getState().messages.find((m) => m.role === "assistant" && m.turnId === turnId);
    const entry = message?.role === "assistant" ? message.drafts.find((d) => d.draft.draftId === draftId) : undefined;
    if (!entry) return;
    // The store updates synchronously, so a double click sees the first
    // click's result right here — the line can't be added twice.
    if (entry.decision.state === "added" || entry.decision.state === "discarded") return;

    if (choice === "discard") {
      discardDraftPreview(draftId);
      store.dispatch({ type: "draftDecided", turnId, draftId, decision: { state: "discarded" } });
      track("AI Draft Line Discarded", { line_type: entry.draft.type });
      return;
    }

    const bridge = getBridge();
    let result: { ok: true; routeId: string } | { ok: false; error: string };
    if (!bridge) {
      result = { ok: false, error: "The map isn't ready yet. Try again in a moment." };
    } else {
      try {
        result = bridge.commitDraftLine(entry.draft);
      } catch (error) {
        console.error("[ask-ai] commitDraftLine failed:", error);
        result = { ok: false, error: error instanceof Error ? error.message : "Couldn't add the line." };
      }
    }
    store.dispatch({
      type: "draftDecided",
      turnId,
      draftId,
      decision: result.ok ? { state: "added", routeId: result.routeId } : { state: "failed", error: result.error },
    });
    track("AI Draft Line Added", { ok: result.ok, line_type: entry.draft.type });
  }

  return {
    actions: { send, stop, retry, newChat, decideDraft },

    snapshotIfInterrupted() {
      const turn = activeTurn;
      if (!turn) return null;
      // What Stop would produce — computed with the pure reducer, NOT dispatched.
      return conversationReducer(store.getState(), {
        type: "turnFinished",
        turnId: turn.turnId,
        outcome: "stopped",
        finalText: turn.answerText,
      });
    },

    dispose() {
      const turn = activeTurn;
      if (!turn) return;
      // Same as Stop — so the store never stays stuck in "streaming" if React
      // re-runs the provider's effects (e.g. Fast Refresh while developing).
      finishTurn(turn, "stopped");
      turn.controller.abort();
    },
  };
}
