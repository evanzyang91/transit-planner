/**
 * THE capital-cost model: one formula for every place the app shows what a
 * line would cost (council scorecard, the generated-route card, Analysis →
 * Feasibility Doc and Cost Estimator, the AI assistant's draft lines).
 *
 *   capital ($B) = km × perKm(mode) + stations × perStation(mode)
 *
 * Why this file exists: the same 10 km, 10-station subway used to cost $5.0B,
 * $6.5B or $11.5B depending on which panel you opened. route-metrics.ts already
 * held the documented formula, but it is `server-only`, so the client panels
 * kept their own copies. This module has no server imports, so both sides can
 * use it; route-metrics.ts re-exports MODE_COSTS and costBn from here.
 *
 * The numbers are order-of-magnitude planning defaults, not quotes:
 * recent Toronto subway stations land in the $100–300M range.
 */

export type CostMode = "subway" | "lrt" | "streetcar" | "bus";

/** Per-mode capital cost in $B. */
export const MODE_COSTS: Record<CostMode, { perKmBn: number; perStationBn: number }> = {
  subway: { perKmBn: 0.5, perStationBn: 0.15 },
  lrt: { perKmBn: 0.08, perStationBn: 0.025 },
  streetcar: { perKmBn: 0.08, perStationBn: 0.025 },
  bus: { perKmBn: 0.004, perStationBn: 0.001 },
};

/** Capital cost in $B: `km × perKm(mode) + stations × perStation(mode)`. */
export function costBn(totalKm: number, stopCount: number, mode: CostMode = "subway"): number {
  const unit = MODE_COSTS[mode];
  return totalKm * unit.perKmBn + stopCount * unit.perStationBn;
}

/**
 * Maps a route's `type` (which also includes "go_train") to a cost mode.
 * GO rail reuses the LRT rate: $80M/km is exactly what the Feasibility Doc
 * charged GO lines before the formulas were merged.
 */
export function costModeFor(routeType: string): CostMode {
  if (routeType === "subway" || routeType === "lrt" || routeType === "streetcar" || routeType === "bus") {
    return routeType;
  }
  return "lrt";
}

/** Operating cost in $M per route-km per year (the Analysis panel's figure, now in one place). */
export const OPERATING_COST_M_PER_KM_YEAR = 1.8;

// ── Alignment (Cost Estimator sliders) ──────────────────────────────────────

/** Relative cost of building one km in each alignment, surface = 1. */
export const ALIGNMENT_FACTORS = { surface: 1, elevated: 2, tunnel: 5 } as const;
export type Alignment = keyof typeof ALIGNMENT_FACTORS;

/**
 * The alignment that MODE_COSTS' per-km rate already assumes. Subways are
 * priced as tunnelled; LRT, streetcar and bus as surface running.
 */
export const TYPICAL_ALIGNMENT: Record<CostMode, Alignment> = {
  subway: "tunnel",
  lrt: "surface",
  streetcar: "surface",
  bus: "surface",
};

export interface AlignmentMix {
  /** Share of the line in tunnel, 0–100. */
  tunnelPct: number;
  /** Share of the line elevated, 0–100. The rest is surface. */
  elevatedPct: number;
}

/** The slider starting point for a mode: its typical alignment, so the estimator opens on the headline number. */
export function typicalMix(mode: CostMode): AlignmentMix {
  const typical = TYPICAL_ALIGNMENT[mode];
  return { tunnelPct: typical === "tunnel" ? 100 : 0, elevatedPct: typical === "elevated" ? 100 : 0 };
}

/**
 * Capital cost in $B for a custom alignment mix:
 *
 *   km × perKm × (s·1 + e·2 + t·5) / typicalFactor(mode) + stations × perStation
 *
 * where s, e, t are the surface / elevated / tunnel shares (0–1). Dividing by
 * the mode's typical factor anchors the scale: at the typical alignment this
 * returns exactly costBn(), so the estimator and every other panel agree.
 * 📖 Learn: "anchoring" a multiplier to a reference case is how you add a
 * what-if knob without changing the baseline number people already see.
 */
export function alignmentCostBn(totalKm: number, stopCount: number, mode: CostMode, mix: AlignmentMix): number {
  const tunnel = clampPct(mix.tunnelPct) / 100;
  const elevated = Math.min(clampPct(mix.elevatedPct) / 100, 1 - tunnel);
  const surface = 1 - tunnel - elevated;
  const mixFactor =
    surface * ALIGNMENT_FACTORS.surface + elevated * ALIGNMENT_FACTORS.elevated + tunnel * ALIGNMENT_FACTORS.tunnel;
  const typicalFactor = ALIGNMENT_FACTORS[TYPICAL_ALIGNMENT[mode]];
  const unit = MODE_COSTS[mode];
  return totalKm * unit.perKmBn * (mixFactor / typicalFactor) + stopCount * unit.perStationBn;
}

function clampPct(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

/** "$6.5B" at or above $1B, "$450M" below it. */
export function formatCostBn(bn: number): string {
  const millions = Math.round(bn * 1000);
  return millions >= 1000 ? `$${(millions / 1000).toFixed(1)}B` : `$${millions}M`;
}
