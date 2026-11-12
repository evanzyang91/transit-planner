"use client";

import { SparkleIcon } from "./icons";

/**
 * One suggestion per thing the assistant can do, so the empty chat doubles as
 * a feature list: explain what's on screen, find gaps, switch layers, run the
 * simulation, draft a line (confirm card), and app how-tos.
 */
export const SUGGESTIONS = [
  "What's the heatmap on my map?",
  "Where are the biggest coverage gaps?",
  "Turn on the transit deserts layer",
  "Run a simulation of my lines",
  "Draft a subway line along Eglinton East",
  "How do I save my plan?",
] as const;

/** Clicking a suggestion SENDS it (it used to only fill the input). */
export function EmptyState({ onPick, disabled }: { onPick: (text: string) => void; disabled: boolean }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
      <div className="flex items-start gap-2">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300"
          aria-hidden="true"
        >
          <SparkleIcon className="h-3.5 w-3.5" />
        </span>
        <p className="text-[13px] leading-relaxed text-stone-700 dark:text-stone-200">
          I can explain what&apos;s on your map, switch layers, run the commuter simulation and draft new lines
          for you to approve.
        </p>
      </div>
      <p className="mb-1.5 mt-4 text-[11px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        Try asking
      </p>
      <ul className="flex flex-col gap-1.5">
        {SUGGESTIONS.map((suggestion) => (
          <li key={suggestion}>
            <button
              type="button"
              onClick={() => onPick(suggestion)}
              disabled={disabled}
              className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-left text-[12.5px] text-stone-700 transition-colors hover:border-teal-300 hover:bg-teal-50 hover:text-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-teal-700 dark:hover:bg-teal-950/40 dark:hover:text-teal-200"
            >
              {suggestion}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
