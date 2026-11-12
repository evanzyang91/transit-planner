/**
 * The Ask AI conversation as a pure reducer plus a tiny store.
 *
 * 📖 Learn: reducer — a function (state, action) => newState that never
 * mutates `state` and has no side effects. Every way the chat can change is
 * one named action below, which makes the streaming logic easy to follow and
 * to unit-test without React.
 *
 * Why a hand-rolled store instead of useReducer? The streaming code is a long
 * async function (fetch → read events → finish). It needs the CURRENT state at
 * arbitrary moments (e.g. "build the history now"), but a useReducer value
 * captured in that function's closure would be stale. A store's getState() is
 * always current, and React reads the same store through useSyncExternalStore.
 * 📖 Learn: useSyncExternalStore — React's official way to read state that
 * lives outside React, without tearing (two components seeing different values).
 */

import {
  fallbackTurnTranscript,
  sanitizeTranscript,
  type AssistantChatMessage,
  type ChatMessage,
  type ChatStep,
  type DraftDecision,
  type StepState,
  type TurnTranscript,
} from "~/lib/map-assistant-history";
import type { DraftLine, TranscriptMessage } from "~/lib/map-assistant-protocol";

export interface ConversationState {
  messages: ChatMessage[];
  /** Model-facing transcript, one chunk per finished turn. */
  transcript: TurnTranscript[];
  /** The turn currently streaming, or null. Never saved. */
  activeTurnId: string | null;
  /** True once the saved chat (if any) has been read from localStorage. */
  hydrated: boolean;
}

export const INITIAL_CONVERSATION: ConversationState = {
  messages: [],
  transcript: [],
  activeTurnId: null,
  hydrated: false,
};

export type TurnOutcome = "done" | "error" | "stopped";

export type ConversationAction =
  /** The saved chat was read after mount (null = nothing saved). */
  | { type: "hydrated"; conversation: { messages: ChatMessage[]; transcript: TurnTranscript[] } | null }
  | {
      type: "turnStarted";
      turnId: string;
      userText: string;
      userMessageId: string;
      assistantMessageId: string;
      now: number;
    }
  /** The answer text so far (sent in batches, once per animation frame). */
  | { type: "textFlushed"; turnId: string; text: string }
  /** Insert or update a progress step by its id. */
  | { type: "stepUpserted"; turnId: string; step: ChatStep }
  /** The streamed text was narration: clear the answer and keep `note` as a dim step. */
  | { type: "textReset"; turnId: string; noteId: string; note: string | null }
  | { type: "draftProposed"; turnId: string; draft: DraftLine }
  | { type: "transcriptReceived"; turnId: string; messages: TranscriptMessage[] }
  | {
      type: "turnFinished";
      turnId: string;
      outcome: TurnOutcome;
      finalText: string;
      error?: { message: string; retryable: boolean };
    }
  | { type: "draftDecided"; turnId: string; draftId: string; decision: DraftDecision }
  /** Remove a finished turn completely (used by Retry before resending). */
  | { type: "turnRemoved"; turnId: string }
  | { type: "cleared" };

// ── Small helpers ────────────────────────────────────────────────────────────

/** Applies `update` to the assistant message of `turnId`; returns the same array if nothing changed. */
function updateAssistant(
  messages: ChatMessage[],
  turnId: string,
  update: (message: AssistantChatMessage) => AssistantChatMessage,
): ChatMessage[] {
  let changed = false;
  const next = messages.map((m) => {
    if (m.role !== "assistant" || m.turnId !== turnId) return m;
    const updated = update(m);
    if (updated !== m) changed = true;
    return updated;
  });
  return changed ? next : messages;
}

function finalStepState(outcome: TurnOutcome): StepState {
  if (outcome === "done") return "done";
  if (outcome === "error") return "error";
  return "stopped";
}

// ── The reducer ──────────────────────────────────────────────────────────────

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  // Streaming actions only apply to the turn that is still active. This is
  // the second line of defence (the provider checks a turn token first):
  // a late event from a stopped or replaced turn can never change the chat.
  const isActive = (turnId: string) => state.activeTurnId === turnId;

  switch (action.type) {
    case "hydrated": {
      // If the user already started chatting before the load finished, keep
      // what's on screen rather than replacing it. (Returning the same object
      // when nothing changes — e.g. StrictMode running the load effect twice —
      // means no re-render.)
      if (state.messages.length > 0 || !action.conversation) {
        return state.hydrated ? state : { ...state, hydrated: true };
      }
      return {
        ...state,
        messages: action.conversation.messages,
        transcript: action.conversation.transcript,
        hydrated: true,
      };
    }

    case "turnStarted": {
      if (state.activeTurnId !== null) return state; // one request at a time
      return {
        ...state,
        activeTurnId: action.turnId,
        messages: [
          ...state.messages,
          { id: action.userMessageId, role: "user", turnId: action.turnId, text: action.userText, createdAt: action.now },
          {
            id: action.assistantMessageId,
            role: "assistant",
            turnId: action.turnId,
            text: "",
            status: "streaming",
            steps: [],
            drafts: [],
            createdAt: action.now,
          },
        ],
      };
    }

    case "textFlushed": {
      if (!isActive(action.turnId)) return state;
      const messages = updateAssistant(state.messages, action.turnId, (m) =>
        m.text === action.text ? m : { ...m, text: action.text },
      );
      return messages === state.messages ? state : { ...state, messages };
    }

    case "stepUpserted": {
      if (!isActive(action.turnId)) return state;
      const messages = updateAssistant(state.messages, action.turnId, (m) => {
        const index = m.steps.findIndex((s) => s.id === action.step.id);
        if (index === -1) return { ...m, steps: [...m.steps, action.step] };
        const steps = [...m.steps];
        steps[index] = { ...steps[index]!, ...action.step };
        return { ...m, steps };
      });
      return { ...state, messages };
    }

    case "textReset": {
      if (!isActive(action.turnId)) return state;
      const note = action.note?.trim();
      const messages = updateAssistant(state.messages, action.turnId, (m) => ({
        ...m,
        text: "",
        steps: note ? [...m.steps, { id: action.noteId, kind: "note", label: note, state: "done" }] : m.steps,
      }));
      return { ...state, messages };
    }

    case "draftProposed": {
      if (!isActive(action.turnId)) return state;
      const messages = updateAssistant(state.messages, action.turnId, (m) => {
        // Same draftId twice (e.g. the server re-sent it) → replace, don't duplicate.
        const others = m.drafts.filter((d) => d.draft.draftId !== action.draft.draftId);
        return { ...m, drafts: [...others, { draft: action.draft, decision: { state: "pending" } }] };
      });
      return { ...state, messages };
    }

    case "transcriptReceived": {
      if (!isActive(action.turnId)) return state;
      const messages = sanitizeTranscript(action.messages);
      if (messages.length === 0) return state;
      const others = state.transcript.filter((t) => t.turnId !== action.turnId);
      return { ...state, transcript: [...others, { turnId: action.turnId, messages }] };
    }

    case "turnFinished": {
      if (!isActive(action.turnId)) return state;
      const stepState = finalStepState(action.outcome);
      const messages = updateAssistant(state.messages, action.turnId, (m) => {
        const finished: AssistantChatMessage = {
          ...m,
          text: action.finalText,
          status: action.outcome,
          // Anything still spinning stops spinning: it finished, failed or was cut off with the turn.
          steps: m.steps.map((s) => (s.state === "running" ? { ...s, state: stepState } : s)),
        };
        if (action.error) finished.error = action.error;
        return finished;
      });

      // Make sure the model will remember this turn. The server's `turn`
      // event is the best record; without it, keep a text-only stand-in.
      let transcript = state.transcript;
      const hasServerTranscript = transcript.some((t) => t.turnId === action.turnId);
      if (!hasServerTranscript) {
        const userMessage = state.messages.find((m) => m.role === "user" && m.turnId === action.turnId);
        if (userMessage) {
          const reason = action.outcome === "done" ? "completed" : action.outcome === "stopped" ? "stopped" : "failed";
          transcript = [
            ...transcript,
            { turnId: action.turnId, messages: fallbackTurnTranscript(userMessage.text, action.finalText, reason) },
          ];
        }
      }
      return { ...state, messages, transcript, activeTurnId: null };
    }

    case "draftDecided": {
      const messages = updateAssistant(state.messages, action.turnId, (m) => {
        const index = m.drafts.findIndex((d) => d.draft.draftId === action.draftId);
        if (index === -1) return m;
        const current = m.drafts[index]!.decision.state;
        // "added" and "discarded" are final — a second click can't flip them.
        if (current === "added" || current === "discarded") return m;
        const drafts = [...m.drafts];
        drafts[index] = { ...drafts[index]!, decision: action.decision };
        return { ...m, drafts };
      });
      return messages === state.messages ? state : { ...state, messages };
    }

    case "turnRemoved": {
      if (isActive(action.turnId)) return state; // stop it first
      return {
        ...state,
        messages: state.messages.filter((m) => m.turnId !== action.turnId),
        transcript: state.transcript.filter((t) => t.turnId !== action.turnId),
      };
    }

    case "cleared":
      return { ...state, messages: [], transcript: [], activeTurnId: null };

    default:
      return state;
  }
}

// ── Selectors (read-only questions about the state) ──────────────────────────

/**
 * The turn a Retry button may resend: the LAST assistant message, if it failed
 * with a retryable error and nothing is streaming. Older failures aren't
 * retryable — resending them would reorder the conversation.
 */
export function getRetryableTurn(state: ConversationState): { turnId: string; userText: string } | null {
  if (state.activeTurnId !== null) return null;
  const last = state.messages[state.messages.length - 1];
  if (last?.role !== "assistant" || last.status !== "error" || !last.error?.retryable) return null;
  const user = state.messages.find((m) => m.role === "user" && m.turnId === last.turnId);
  return user ? { turnId: last.turnId, userText: user.text } : null;
}

/** Every draft still waiting for the user's choice (New chat discards their map previews). */
export function getPendingDrafts(state: ConversationState): Array<{ turnId: string; draftId: string }> {
  const pending: Array<{ turnId: string; draftId: string }> = [];
  for (const m of state.messages) {
    if (m.role !== "assistant") continue;
    for (const d of m.drafts) {
      if (d.decision.state === "pending" || d.decision.state === "failed") {
        pending.push({ turnId: m.turnId, draftId: d.draft.draftId });
      }
    }
  }
  return pending;
}

// ── The store ────────────────────────────────────────────────────────────────

/** Function properties (not methods): React calls `store.subscribe` / `store.getState` detached from `store`. */
export interface ConversationStore {
  getState: () => ConversationState;
  dispatch: (action: ConversationAction) => void;
  /** Returns an unsubscribe function (the shape useSyncExternalStore expects). */
  subscribe: (listener: () => void) => () => void;
}

export function createConversationStore(initial: ConversationState = INITIAL_CONVERSATION): ConversationStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      const next = conversationReducer(state, action);
      if (next === state) return; // nothing changed → no re-render
      state = next;
      // Copy first so a listener that unsubscribes while we loop is safe.
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
