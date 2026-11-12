"use client";

import { useId, useState } from "react";
import type { ChatStep } from "~/lib/map-assistant-history";
import { CheckIcon, ChevronIcon, DashIcon, ErrorIcon, SpinnerIcon } from "./icons";

/**
 * "What I'm doing" list for one answer: tool steps (spinner → check / error)
 * and dim narration notes. While the answer streams the list is open so the
 * user sees progress; once it's done it collapses to "N steps", expandable.
 */
export function StepList({ steps, live }: { steps: ChatStep[]; live: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  if (steps.length === 0) return null;

  const open = live || expanded;
  const countLabel = `${steps.length} step${steps.length === 1 ? "" : "s"}`;

  return (
    <div className="mb-1.5">
      {!live && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          aria-controls={listId}
          className="flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-stone-500 hover:bg-stone-100 hover:text-stone-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-200"
        >
          <ChevronIcon className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`} />
          {countLabel}
        </button>
      )}
      {open && (
        <ul id={listId} className={`space-y-0.5 ${live ? "" : "mt-1 pl-1"}`} aria-label="Steps">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ul>
      )}
    </div>
  );
}

const STATE_TEXT: Record<ChatStep["state"], string> = {
  running: "In progress",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
};

function StepRow({ step }: { step: ChatStep }) {
  if (step.kind === "note") {
    // Narration that turned out not to be the answer ("Let me check…").
    return (
      <li className="flex items-start gap-2 text-[12px] leading-5 text-stone-500 dark:text-stone-400">
        <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-stone-400" aria-hidden="true" />
        <span className="italic">{step.label}</span>
      </li>
    );
  }
  return (
    <li className="flex items-start gap-2 text-[12px] leading-5 text-stone-600 dark:text-stone-300">
      <span className="mt-[3px] shrink-0">
        <StepIcon state={step.state} />
      </span>
      <span>
        <span className="sr-only">{STATE_TEXT[step.state]}: </span>
        {step.label}
      </span>
    </li>
  );
}

function StepIcon({ state }: { state: ChatStep["state"] }) {
  switch (state) {
    case "running":
      return <SpinnerIcon className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />;
    case "done":
      return <CheckIcon className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />;
    case "error":
      return <ErrorIcon className="h-3.5 w-3.5 text-rose-600 dark:text-rose-400" />;
    case "stopped":
      return <DashIcon className="h-3.5 w-3.5 text-stone-400" />;
  }
}
