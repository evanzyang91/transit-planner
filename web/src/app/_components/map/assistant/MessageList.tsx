"use client";

import { useEffect, useMemo, useRef } from "react";
import { useAIAnnotations, type AIAnnotation } from "../AIAnnotationsContext";
import type { ChatMessage } from "~/lib/map-assistant-history";
import { AssistantMessageRow, UserMessageRow } from "./MessageRows";

/** Shared empty array, so rows without annotations always get the SAME object (keeps memo effective). */
const NO_ANNOTATIONS: AIAnnotation[] = [];

/** How close to the bottom (px) still counts as "reading the latest". */
const STICK_THRESHOLD_PX = 40;

export function MessageList({
  messages,
  isStreaming,
  retryableTurnId,
  onRetry,
  onDecideDraft,
}: {
  messages: ChatMessage[];
  isStreaming: boolean;
  retryableTurnId: string | null;
  onRetry: () => void;
  onDecideDraft: (turnId: string, draftId: string, choice: "add" | "discard") => void;
}) {
  const { annotations, focusAnnotation, removeAnnotation } = useAIAnnotations();
  const listRef = useRef<HTMLDivElement>(null);

  // Follow new content only while the user is parked near the bottom, so a
  // streaming answer doesn't yank them away from history they scrolled up to read.
  const stickToBottomRef = useRef(true);

  // Group annotations by the turn that drew them (one pass, not a filter per row).
  const annotationsByTurn = useMemo(() => {
    const groups = new Map<string, AIAnnotation[]>();
    for (const annotation of annotations) {
      const group = groups.get(annotation.turnId);
      if (group) group.push(annotation);
      else groups.set(annotation.turnId, [annotation]);
    }
    return groups;
  }, [annotations]);

  // Sending a message always jumps back to the bottom.
  const lastUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role === "user") return m.id;
    }
    return null;
  }, [messages]);
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [lastUserMessageId]);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = listRef.current;
    if (!el) return;
    // Scroll the list itself (not scrollIntoView, which can also scroll the
    // page and make the card jump). Instant while streaming — a smooth scroll
    // per frame would lag behind the text — and smooth otherwise, unless the
    // user asked the OS for reduced motion.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    el.scrollTo({ top: el.scrollHeight, behavior: isStreaming || reduceMotion ? "auto" : "smooth" });
  }, [messages, isStreaming, annotations]);

  return (
    <div
      ref={listRef}
      onScroll={() => {
        const el = listRef.current;
        if (!el) return;
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX;
      }}
      // 📖 Learn: role="log" is an ARIA live region for chat-like content —
      // screen readers announce new rows. aria-busy asks them to wait while an
      // answer is still streaming instead of reading every token.
      role="log"
      aria-live="polite"
      aria-busy={isStreaming}
      aria-label="Conversation"
      tabIndex={0}
      className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500/60"
    >
      {messages.map((message) =>
        message.role === "user" ? (
          <UserMessageRow key={message.id} message={message} />
        ) : (
          <AssistantMessageRow
            key={message.id}
            message={message}
            annotations={annotationsByTurn.get(message.turnId) ?? NO_ANNOTATIONS}
            canRetry={message.turnId === retryableTurnId}
            onRetry={onRetry}
            onDecideDraft={onDecideDraft}
            onFocusAnnotation={focusAnnotation}
            onRemoveAnnotation={removeAnnotation}
          />
        ),
      )}
    </div>
  );
}
