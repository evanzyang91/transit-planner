"use client";

import type { DraftEntry } from "~/lib/map-assistant-history";
import type { LineType } from "~/lib/map-assistant-protocol";
import { formatCost, formatKm, formatPopulation, safeHexColor } from "./format";

const TYPE_LABEL: Record<LineType, string> = {
  subway: "Subway",
  lrt: "LRT",
  streetcar: "Streetcar",
  bus: "Bus",
};

/**
 * Human-in-the-loop confirm card for a line the assistant drafted
 * (propose_line). The draft is only a preview on the map; nothing is added to
 * the plan until "Add to map" is clicked. The choice is saved with the chat,
 * so after a reload the card still shows "Added ✓" / "Discarded".
 */
export function DraftLineCard({
  entry,
  onAdd,
  onDiscard,
}: {
  entry: DraftEntry;
  onAdd: () => void;
  onDiscard: () => void;
}) {
  const { draft, decision } = entry;
  const decided = decision.state === "added" || decision.state === "discarded";
  const firstStop = draft.stops[0]?.name;
  const lastStop = draft.stops[draft.stops.length - 1]?.name;

  return (
    <section
      aria-label={`Draft line: ${draft.name}`}
      className="mt-2 rounded-xl border border-teal-200 bg-white p-3 shadow-sm dark:border-teal-800/70 dark:bg-stone-900"
    >
      <div className="flex items-center gap-2">
        <span
          className="h-3 w-3 shrink-0 rounded-full"
          style={{ background: safeHexColor(draft.color) }}
          aria-hidden="true"
        />
        <h4 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-stone-800 dark:text-stone-100">
          {draft.name}
        </h4>
        <span className="shrink-0 rounded-full bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-stone-700 dark:bg-stone-800 dark:text-stone-200">
          {TYPE_LABEL[draft.type]}
        </span>
      </div>
      <p className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-400">
        Draft — not part of your plan until you add it.
      </p>
      {firstStop && lastStop && (
        <p className="mt-1.5 truncate text-[12px] text-stone-600 dark:text-stone-300" title={draft.stops.map((s) => s.name).join(" → ")}>
          {firstStop} → {lastStop}
        </p>
      )}
      {draft.rationale && (
        <p className="mt-1 text-[12px] leading-snug text-stone-600 dark:text-stone-300">{draft.rationale}</p>
      )}

      <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px]">
        {/* stats come off the wire: fall back to counting the stops if the number is missing */}
        <Stat
          label="Stops"
          value={String(typeof draft.stats.stopCount === "number" ? draft.stats.stopCount : draft.stops.length)}
        />
        <Stat label="Length" value={formatKm(draft.stats.lengthKm)} />
        <Stat label="Avg spacing" value={formatKm(draft.stats.avgSpacingKm)} />
        <Stat label="Est. cost" value={formatCost(draft.stats.estCostBillions)} />
        <Stat label="Population served" value={formatPopulation(draft.stats.populationServed)} />
      </dl>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onAdd}
          disabled={decided}
          className="rounded-lg bg-teal-700 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add to map
        </button>
        <button
          type="button"
          onClick={onDiscard}
          disabled={decided}
          className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-[12px] font-medium text-stone-700 hover:bg-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          Discard
        </button>
        {/* role="status" announces the outcome to screen readers without moving focus. */}
        <span role="status" className="text-[12px]">
          {decision.state === "added" && (
            <span className="font-semibold text-teal-700 dark:text-teal-300">Added ✓</span>
          )}
          {decision.state === "discarded" && <span className="text-stone-500 dark:text-stone-400">Discarded</span>}
        </span>
      </div>
      {decision.state === "failed" && (
        <p role="alert" className="mt-2 text-[12px] text-rose-700 dark:text-rose-300">
          {decision.error}
        </p>
      )}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-stone-500 dark:text-stone-400">{label}</dt>
      <dd className="font-semibold tabular-nums text-stone-800 dark:text-stone-100">{value}</dd>
    </div>
  );
}
