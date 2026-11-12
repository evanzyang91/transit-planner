"use client";

/**
 * MapAssistantProvider — owns the Ask AI conversation for the whole /map page.
 *
 * Why a provider (and not state inside the chat panel)?
 *  • The answer keeps streaming when the panel is closed (it used to be lost).
 *  • The floating card and the Analysis-panel card show the SAME chat.
 *  • TransitMap registers a "bridge" so the assistant can read the map (routes
 *    + what's on screen) and act on it (layers, panels, draft lines…).
 *
 * The chat is stored in this browser (localStorage) and its model-facing part
 * is sent back as `history` with each message. The server keeps nothing, so a
 * restart can't make the assistant forget ("Unknown thread: <uuid>" is gone).
 *
 * Mount order (page.tsx):
 *   <AIAnnotationsProvider><MapAssistantProvider><TransitMap/></MapAssistantProvider></AIAnnotationsProvider>
 * It must sit INSIDE AIAnnotationsProvider because drawing tools add map annotations.
 *
 * The streaming logic itself lives in ./assistant/chat-engine.ts (plain
 * TypeScript); this file wires it to React and to localStorage.
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { useAIAnnotations } from "./AIAnnotationsContext";
import {
  createChatEngine,
  type AnnotationApi,
  type MapAssistantActions,
  type MapAssistantBridge,
} from "./assistant/chat-engine";
import {
  createConversationStore,
  getRetryableTurn,
  type ConversationState,
  type ConversationStore,
} from "./assistant/conversation";
import { trackEvent } from "~/lib/analytics";
import {
  CHAT_STORAGE_KEY,
  LEGACY_CHAT_STORAGE_KEY,
  loadStoredConversation,
  MAX_STORED_TURNS,
  serializeConversation,
  trimConversation,
  type ChatMessage,
} from "~/lib/map-assistant-history";
import { HISTORY_LIMITS } from "~/lib/map-assistant-protocol";

export type { MapAssistantActions, MapAssistantBridge };

export interface MapAssistantApi extends MapAssistantActions {
  messages: ChatMessage[];
  isStreaming: boolean;
  /** False until the saved chat has been loaded (right after mount). */
  hydrated: boolean;
  /** The failed turn that `retry()` would resend, or null. */
  retryableTurnId: string | null;
}

interface MapAssistantContextValue {
  store: ConversationStore;
  actions: MapAssistantActions;
  bridgeRef: MutableRefObject<MapAssistantBridge | null>;
}

const MapAssistantContext = createContext<MapAssistantContextValue | null>(null);

// ── localStorage helpers (all wrapped: storage can be full or blocked) ───────

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage blocked — nothing to remove */
  }
}

/**
 * Saves the chat; returns false if it couldn't. The usual failure is the
 * ~5 MB per-site quota (shared with e.g. cached Street View images), so we
 * retry once keeping only the turns the model would see anyway.
 */
function writeConversation(state: ConversationState): boolean {
  if (state.messages.length === 0 && state.transcript.length === 0) {
    removeStorage(CHAT_STORAGE_KEY);
    return true;
  }
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, serializeConversation(trimConversation(state, MAX_STORED_TURNS)));
    return true;
  } catch (firstError) {
    try {
      localStorage.setItem(
        CHAT_STORAGE_KEY,
        serializeConversation(trimConversation(state, HISTORY_LIMITS.maxUserTurns)),
      );
      return true;
    } catch {
      console.warn("[ask-ai] Couldn't save the chat in this browser (storage full or blocked).", firstError);
      return false;
    }
  }
}

// ── The provider ─────────────────────────────────────────────────────────────

export function MapAssistantProvider({ children }: { children: ReactNode }) {
  const bridgeRef = useRef<MapAssistantBridge | null>(null);

  // Read the annotation functions through a ref, so the engine (created once)
  // always calls the current ones.
  const annotations = useAIAnnotations();
  const annotationsRef = useRef<AnnotationApi>(annotations);
  useLayoutEffect(() => {
    annotationsRef.current = annotations;
  });

  // 📖 Learn: useState(initializer) runs the initializer ONCE, so the store and
  // the engine keep their identity for the provider's whole life. (useMemo is
  // only a cache React may throw away; useState is a guarantee.)
  const [store] = useState(() => createConversationStore());
  const [engine] = useState(() =>
    createChatEngine({
      store,
      getBridge: () => bridgeRef.current,
      getAnnotations: () => annotationsRef.current,
      track: trackEvent,
    }),
  );

  // ── Load the saved chat after mount ──
  // In an effect, not during render: the server can't read localStorage, so
  // reading it while rendering would make the first client render differ from
  // the server HTML (a hydration mismatch).
  useEffect(() => {
    const v2Raw = readStorage(CHAT_STORAGE_KEY);
    const v1Raw = readStorage(LEGACY_CHAT_STORAGE_KEY);
    const { conversation, migratedFromV1 } = loadStoredConversation(v2Raw, v1Raw);
    store.dispatch({ type: "hydrated", conversation });
    if (migratedFromV1) {
      // Save under the new key first; only then forget the old one.
      if (writeConversation(store.getState())) removeStorage(LEGACY_CHAT_STORAGE_KEY);
    } else if (v1Raw !== null) {
      removeStorage(LEGACY_CHAT_STORAGE_KEY); // already migrated earlier, or nothing usable in it
    }
  }, [store]);

  // ── Save when a turn ends, on New chat and on a draft choice — never per token ──
  useEffect(() => {
    let lastSaved: ConversationState | null = null;
    return store.subscribe(() => {
      const state = store.getState();
      if (!state.hydrated) return; // don't overwrite the saved chat before it is loaded
      if (state.activeTurnId !== null) return; // streaming: wait for the turn to end
      // Nothing new since the last save (e.g. only `hydrated` flipped).
      if (lastSaved?.messages === state.messages && lastSaved.transcript === state.transcript) return;
      lastSaved = state;
      writeConversation(state);
    });
  }, [store]);

  // ── Leaving mid-answer (tab closed, or navigating away from /map) ──
  // Save the turn as "stopped" so the question isn't lost, then abort it.
  useEffect(() => {
    function saveInterruptedTurn() {
      const snapshot = engine.snapshotIfInterrupted();
      if (snapshot?.hydrated) writeConversation(snapshot);
    }
    // 📖 Learn: "pagehide" fires reliably when a tab closes or navigates away
    // (more reliably than "beforeunload", especially on mobile).
    window.addEventListener("pagehide", saveInterruptedTurn);
    return () => {
      window.removeEventListener("pagehide", saveInterruptedTurn);
      saveInterruptedTurn();
      engine.dispose();
    };
  }, [engine]);

  const value = useMemo<MapAssistantContextValue>(
    () => ({ store, actions: engine.actions, bridgeRef }),
    [store, engine],
  );
  return <MapAssistantContext.Provider value={value}>{children}</MapAssistantContext.Provider>;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * The chat state + actions, for the chat UI. It re-renders its caller on every
 * streamed chunk — so TransitMap should NOT use it; it should use
 * useRegisterMapAssistantBridge (and useMapAssistantActions if it needs to
 * send or stop).
 */
export function useMapAssistant(): MapAssistantApi {
  const context = useContext(MapAssistantContext);
  if (!context) throw new Error("useMapAssistant() must be used inside <MapAssistantProvider>.");
  const { store, actions } = context;
  // 📖 Learn: useSyncExternalStore subscribes a component to a store that lives
  // outside React; the third argument is the snapshot used for server rendering.
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return useMemo(
    () => ({
      messages: state.messages,
      isStreaming: state.activeTurnId !== null,
      hydrated: state.hydrated,
      retryableTurnId: getRetryableTurn(state)?.turnId ?? null,
      ...actions,
    }),
    [state, actions],
  );
}

/** Only the stable actions (send, stop, newChat, …). Never re-renders its caller. */
export function useMapAssistantActions(): MapAssistantActions {
  const context = useContext(MapAssistantContext);
  if (!context) throw new Error("useMapAssistantActions() must be used inside <MapAssistantProvider>.");
  return context.actions;
}

/**
 * TransitMap calls this on EVERY render with fresh callbacks. They are kept in
 * a ref — no state, no re-render, no subscription loop — and the assistant
 * calls whichever bridge is current when it needs one.
 *
 * Why an effect instead of assigning the ref during render? React may render
 * a component and then throw that render away (StrictMode, concurrent
 * rendering); effects only run for renders that were actually committed.
 * 📖 Learn: useLayoutEffect runs right after React updates the DOM and before
 * the browser paints, so the bridge is current before any click can happen.
 */
export function useRegisterMapAssistantBridge(bridge: MapAssistantBridge): void {
  const context = useContext(MapAssistantContext);
  const bridgeRef = context?.bridgeRef ?? null;

  // No dependency array on purpose: store the newest callbacks after every render.
  useLayoutEffect(() => {
    if (bridgeRef) bridgeRef.current = bridge;
  });

  // Unmount only: stop calling into a map that is gone.
  useLayoutEffect(() => {
    if (!bridgeRef) {
      console.warn(
        "[ask-ai] useRegisterMapAssistantBridge() was called outside <MapAssistantProvider>; the assistant can't see the map.",
      );
      return;
    }
    return () => {
      bridgeRef.current = null;
    };
  }, [bridgeRef]);
}
