"use client";

import { useEffect, useRef, useState } from "react";
import { useMapAssistant } from "./MapAssistantContext";
import { Composer } from "./assistant/Composer";
import { EmptyState } from "./assistant/EmptyState";
import { FindingsBar } from "./assistant/FindingsBar";
import { NewChatIcon } from "./assistant/icons";
import { MessageList } from "./assistant/MessageList";

interface Props {
  /** Text to pre-fill the message box (one-shot; e.g. "About Malvern (43.80, -79.22): "). Never auto-sent. */
  seed?: string | null;
  onSeedConsumed?: () => void;
  /**
   * "panel"    — inside the floating Ask AI card (AIChatPanel draws the header).
   * "embedded" — the Analysis panel's AI Assistant card: same conversation,
   *              no window chrome, its own small "New chat" row.
   */
  variant?: "panel" | "embedded";
}

/**
 * The chat itself: findings bar, messages (or suggestions), and the message
 * box. All conversation state comes from MapAssistantProvider, so every
 * TransitAssistant on the page shows the same chat. Only the text being typed
 * is local to each one.
 */
export function TransitAssistant({ seed, onSeedConsumed, variant = "panel" }: Props) {
  const { messages, isStreaming, hydrated, retryableTurnId, send, stop, retry, newChat, decideDraft } =
    useMapAssistant();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // A seed pre-fills the box and puts the cursor at the end — the user still
  // decides whether to send it.
  useEffect(() => {
    if (!seed) return;
    setInput(seed);
    onSeedConsumed?.();
    // Wait a frame so the new text is in the textarea before placing the cursor.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(seed.length, seed.length);
    });
    // onSeedConsumed is a new function on every parent render; re-running for it would be wrong.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  // Opening the floating card puts the cursor in the message box.
  useEffect(() => {
    if (variant === "panel") textareaRef.current?.focus({ preventScroll: true });
  }, [variant]);

  function submit() {
    const text = input.trim();
    if (!text || isStreaming || !hydrated) return;
    send(text);
    setInput("");
  }

  function pickSuggestion(text: string) {
    if (isStreaming || !hydrated) return;
    send(text);
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {variant === "embedded" && (
        <div className="flex shrink-0 items-center justify-between gap-2 pb-1.5">
          <p className="text-[11px] text-stone-500 dark:text-stone-400">Same chat as the Ask AI window</p>
          <button
            type="button"
            onClick={newChat}
            disabled={messages.length === 0}
            title="Start a new chat"
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:text-stone-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:opacity-40 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-white"
          >
            <NewChatIcon className="h-3.5 w-3.5" />
            New chat
          </button>
        </div>
      )}

      <FindingsBar />

      {messages.length > 0 ? (
        <MessageList
          messages={messages}
          isStreaming={isStreaming}
          retryableTurnId={retryableTurnId}
          onRetry={retry}
          onDecideDraft={decideDraft}
        />
      ) : hydrated ? (
        <EmptyState onPick={pickSuggestion} disabled={isStreaming} />
      ) : (
        // The saved chat loads right after mount; don't flash the suggestions before it.
        <div className="min-h-0 flex-1" />
      )}

      <Composer
        value={input}
        onChange={setInput}
        onSubmit={submit}
        onStop={stop}
        isStreaming={isStreaming}
        disabled={!hydrated}
        textareaRef={textareaRef}
      />
    </div>
  );
}
