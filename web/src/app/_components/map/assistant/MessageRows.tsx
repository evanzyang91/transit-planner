"use client";

import { memo } from "react";
import type { AIAnnotation } from "../AIAnnotationsContext";
import type { AssistantChatMessage, UserChatMessage } from "~/lib/map-assistant-history";
import { AnnotationChips } from "./AnnotationChips";
import { ChatMarkdown } from "./ChatMarkdown";
import { DraftLineCard } from "./DraftLineCard";
import { ErrorIcon, RetryIcon, SparkleIcon } from "./icons";
import { StepList } from "./StepList";

/*
 * One component per chat row, each wrapped in React.memo.
 * 📖 Learn: React.memo skips re-rendering when the props are the same objects
 * as last time. Messages are immutable (the reducer replaces a message
 * instead of editing it), so while an answer streams only ITS row re-renders —
 * older answers aren't re-parsed as markdown on every token.
 */

export const UserMessageRow = memo(function UserMessageRow({ message }: { message: UserChatMessage }) {
  return (
    <div className="flex justify-end pl-8">
      <p className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-stone-100 px-3 py-2 text-[13px] leading-relaxed text-stone-800 dark:bg-stone-800 dark:text-stone-100">
        <span className="sr-only">You: </span>
        {message.text}
      </p>
    </div>
  );
});

export interface AssistantMessageRowProps {
  message: AssistantChatMessage;
  /** Annotations this answer drew (same array object while unchanged, so memo works). */
  annotations: AIAnnotation[];
  /** True only for the latest answer when it failed with a retryable error. */
  canRetry: boolean;
  onRetry: () => void;
  onDecideDraft: (turnId: string, draftId: string, choice: "add" | "discard") => void;
  onFocusAnnotation: (id: string) => void;
  onRemoveAnnotation: (id: string) => void;
}

/*
 * The blinking caret after streaming text. It's drawn with CSS ::after on the
 * last block the markdown produced, so it sits at the end of the last line
 * instead of on a line of its own. `motion-safe:` keeps it still for people
 * who asked their OS for reduced motion.
 */
const STREAMING_CARET =
  "[&>*:last-child]:after:ml-0.5 [&>*:last-child]:after:inline-block [&>*:last-child]:after:text-teal-600 [&>*:last-child]:after:content-['▍'] motion-safe:[&>*:last-child]:after:animate-pulse";

export const AssistantMessageRow = memo(function AssistantMessageRow({
  message,
  annotations,
  canRetry,
  onRetry,
  onDecideDraft,
  onFocusAnnotation,
  onRemoveAnnotation,
}: AssistantMessageRowProps) {
  const streaming = message.status === "streaming";
  const waitingForFirstSign = streaming && message.text === "" && message.steps.length === 0;
  const showsNothing =
    !streaming && message.text === "" && annotations.length === 0 && message.drafts.length === 0 && !message.error;

  return (
    <div className="flex gap-2 pr-2">
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300"
        aria-hidden="true"
      >
        <SparkleIcon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="sr-only">Assistant: </span>
        <StepList steps={message.steps} live={streaming} />

        {waitingForFirstSign && <ThinkingDots />}

        {message.text !== "" && (
          <div
            className={`break-words text-[13px] leading-relaxed text-stone-800 dark:text-stone-100 ${streaming ? STREAMING_CARET : ""}`}
          >
            <ChatMarkdown text={message.text} />
          </div>
        )}

        {showsNothing && message.status === "done" && (
          <p className="text-[12px] text-stone-500 dark:text-stone-400">Done — see the map.</p>
        )}

        <AnnotationChips annotations={annotations} onFocus={onFocusAnnotation} onRemove={onRemoveAnnotation} />

        {message.drafts.map((entry) => (
          <DraftLineCard
            key={entry.draft.draftId}
            entry={entry}
            onAdd={() => onDecideDraft(message.turnId, entry.draft.draftId, "add")}
            onDiscard={() => onDecideDraft(message.turnId, entry.draft.draftId, "discard")}
          />
        ))}

        {message.status === "stopped" && (
          <p className="mt-1 text-[11px] font-medium text-stone-500 dark:text-stone-400">Stopped</p>
        )}

        {message.status === "error" && (
          <div
            role="alert"
            className="mt-2 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-2 text-[12px] text-rose-800 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200"
          >
            <ErrorIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <p className="min-w-0 flex-1">{message.error?.message ?? "Something went wrong."}</p>
            {canRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-semibold text-rose-800 hover:bg-rose-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 dark:text-rose-200 dark:hover:bg-rose-900/40"
              >
                <RetryIcon className="h-3.5 w-3.5" />
                Retry
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** Shown until the first progress step or word arrives. */
function ThinkingDots() {
  return (
    <div className="flex h-6 items-center gap-1" role="status">
      <span className="sr-only">Thinking…</span>
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="h-1.5 w-1.5 rounded-full bg-teal-500/70 motion-safe:animate-bounce"
          style={{ animationDelay: `${delay}ms` }}
          aria-hidden="true"
        />
      ))}
    </div>
  );
}
