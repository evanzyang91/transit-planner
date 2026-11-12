"use client";

import { useAIAnnotations } from "../AIAnnotationsContext";

/**
 * "N map findings · Edit shapes · Clear all".
 * Keep these exact words: the assistant's prompt (server/map-data/prompt.ts)
 * tells users to press "Clear all" next to the findings count.
 */
export function FindingsBar() {
  const { annotations, editing, setEditing, clearAll } = useAIAnnotations();
  if (annotations.length === 0) return null;
  const count = annotations.length;

  return (
    <div className="shrink-0 border-b border-stone-100 px-3 py-1.5 dark:border-stone-800">
      <div className="flex items-center gap-1.5 text-[11px]">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-teal-500" aria-hidden="true" />
        <span className="font-medium text-stone-600 dark:text-stone-300">
          {count} map finding{count === 1 ? "" : "s"}
        </span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          aria-pressed={editing}
          className={`rounded px-1.5 py-0.5 font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 ${
            editing
              ? "bg-teal-50 text-teal-700 dark:bg-teal-500/15 dark:text-teal-300"
              : "text-stone-600 hover:text-stone-900 dark:text-stone-300 dark:hover:text-white"
          }`}
        >
          {editing ? "Done editing" : "Edit shapes"}
        </button>
        <span className="text-stone-300 dark:text-stone-600" aria-hidden="true">
          ·
        </span>
        <button
          type="button"
          onClick={clearAll}
          className="rounded px-1.5 py-0.5 font-medium text-teal-700 hover:text-teal-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-teal-300 dark:hover:text-teal-200"
        >
          Clear all
        </button>
      </div>
      {editing && (
        <p className="mt-1 text-[11px] leading-snug text-stone-500 dark:text-stone-400">
          Drag the dots to reshape. On a shaded area, drag a faint mid-dot to add a corner, or double-click a
          corner to remove it.
        </p>
      )}
    </div>
  );
}
