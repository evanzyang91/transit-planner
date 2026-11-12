"use client";

import { useId, useLayoutEffect, type KeyboardEvent, type RefObject } from "react";
import { MicIcon, SendIcon, StopIcon } from "./icons";
import { useSpeechInput } from "./useSpeechInput";

/** The textarea grows with its text up to this height, then scrolls. */
const MAX_TEXTAREA_HEIGHT_PX = 160;

/**
 * The message box: auto-growing textarea, Enter sends, Shift+Enter adds a
 * line, voice input, and a Send button that turns into Stop while an answer
 * is streaming. One request at a time: while streaming, the box is read-only.
 * (read-only rather than disabled, so focus — and Escape-to-close — stay put.)
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  isStreaming,
  disabled,
  textareaRef,
}: {
  value: string;
  onChange: (text: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  isStreaming: boolean;
  /** True before the saved chat has loaded. */
  disabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const inputId = useId();
  const speech = useSpeechInput(onChange);
  const locked = isStreaming || disabled;
  const canSend = !locked && value.trim() !== "";

  // Auto-grow: shrink to "auto" first so the height can also go DOWN after deleting text.
  // 📖 Learn: useLayoutEffect runs before the browser paints, so there's no flicker.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [value, textareaRef]);

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Escape") {
      // Keep keys typed here away from the map's own keyboard shortcuts, which
      // listen on `document` (Backspace deletes the selected station, ⌘Z undoes
      // a map edit). React's listener also sits on `document` and was added
      // first, so stopping the native event here hides it from the later ones.
      // Escape is let through so the card's Escape-to-close still works.
      event.nativeEvent.stopImmediatePropagation();
    }
    if (event.key === "Enter" && !event.shiftKey) {
      // IME guard: the Enter that confirms a Japanese/Chinese/Korean
      // composition must not send. (keyCode 229 covers Safari, which reports
      // isComposing = false for that Enter.)
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      if (canSend) onSubmit();
    }
  }

  let placeholder = "Ask about your map…";
  if (isStreaming) placeholder = "Answering… press Stop to interrupt";
  else if (speech.listening) placeholder = "Listening…";

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSubmit();
      }}
      className="shrink-0 px-3 pb-3 pt-2"
    >
      {/* The focus RING (not just the border) shows focus: in dark mode globals.css
          forces .border-stone-200 with !important, so the teal border can't appear there. */}
      <div className="rounded-2xl border border-stone-200 bg-white transition-colors focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/40 dark:border-stone-700 dark:bg-stone-900 dark:focus-within:ring-teal-400/60">
        <label htmlFor={inputId} className="sr-only">
          Message the assistant
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          readOnly={locked}
          aria-busy={isStreaming}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent px-3 pb-1 pt-2.5 text-[13px] leading-relaxed text-stone-800 outline-none placeholder:text-stone-500 read-only:cursor-not-allowed read-only:opacity-70 dark:text-stone-100 dark:placeholder:text-stone-400"
          style={{ maxHeight: MAX_TEXTAREA_HEIGHT_PX }}
        />
        <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-0.5">
          <div className="flex items-center gap-1">
            {speech.supported && (
              <button
                type="button"
                onClick={() => speech.toggle(value)}
                disabled={locked}
                title={speech.listening ? "Stop listening" : "Speak instead of typing"}
                aria-label={speech.listening ? "Stop voice input" : "Start voice input"}
                aria-pressed={speech.listening}
                className={`flex h-8 w-8 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:opacity-40 ${
                  speech.listening
                    ? "bg-rose-600 text-white motion-safe:animate-pulse"
                    : "text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
                }`}
              >
                <MicIcon className="h-4 w-4" />
              </button>
            )}
          </div>
          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              title="Stop the answer"
              aria-label="Stop the answer"
              className="flex h-8 items-center gap-1.5 rounded-xl border border-stone-300 bg-white px-3 text-[12px] font-semibold text-stone-700 transition-colors hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              <StopIcon className="h-3 w-3" />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!canSend}
              title="Send (Enter)"
              aria-label="Send message"
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-600 text-white transition-colors hover:bg-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-stone-200 disabled:text-stone-500 dark:disabled:bg-stone-800 dark:disabled:text-stone-500"
            >
              <SendIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
