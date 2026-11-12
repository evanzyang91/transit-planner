"use client";

import type { AIAnnotation } from "../AIAnnotationsContext";
import { CloseIcon } from "./icons";

const KIND_LABEL: Record<AIAnnotation["kind"], string> = {
  highlight: "Area",
  corridor: "Corridor",
  pin: "Pin",
  flyTo: "Map view",
};

/**
 * The shapes one answer drew on the map. Click a label to fly to it; the ×
 * removes it. The × is always visible (it used to appear only on mouse hover,
 * which keyboard and touch users never see).
 */
export function AnnotationChips({
  annotations,
  onFocus,
  onRemove,
}: {
  annotations: AIAnnotation[];
  onFocus: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  if (annotations.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-1" aria-label="Drawn on the map for this answer">
      {annotations.map((annotation) => (
        <li
          key={annotation.id}
          className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white py-0.5 pl-2 pr-0.5 dark:border-stone-700 dark:bg-stone-900"
        >
          <span
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: annotation.color ?? "#14b8a6" }}
            aria-hidden="true"
          />
          <button
            type="button"
            onClick={() => onFocus(annotation.id)}
            title={`${KIND_LABEL[annotation.kind]}: ${annotation.label} — show on the map`}
            className="min-w-0 flex-1 truncate rounded py-0.5 text-left text-[12px] text-stone-700 hover:text-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-stone-200 dark:hover:text-teal-300"
          >
            <span className="sr-only">{KIND_LABEL[annotation.kind]}: </span>
            {annotation.label}
          </button>
          <button
            type="button"
            onClick={() => onRemove(annotation.id)}
            aria-label={`Remove “${annotation.label}” from the map`}
            title="Remove from the map"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-stone-500 hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-stone-400 dark:hover:bg-rose-950/40 dark:hover:text-rose-300"
          >
            <CloseIcon className="h-3 w-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
