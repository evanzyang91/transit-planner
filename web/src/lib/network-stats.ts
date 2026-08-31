/**
 * Shared network geometry stats — importable from BOTH client components and
 * server AI tools, so the numbers the user sees in panels and the numbers the
 * AI reasons with are computed by the same code.
 *
 * Why this file exists: routeLengthKm used to be duplicated in
 * TransitAssistant.tsx and ExperimentalPanel.tsx. Duplicates drift; when the AI
 * quotes "your network is N km" it must be the same N the UI shows.
 */

import { haversineKm } from "~/app/map/geo-utils";

// Structural types (not the full Route) so both full client routes and the
// server's trimmed per-request routes fit without casts.
type StopLike = { coords: [number, number] };
type RouteLike = { stops: StopLike[]; type: string };

/** Total great-circle length of a route in km (sum of consecutive stop gaps). */
export function routeLengthKm(route: { stops: StopLike[] }): number {
  let total = 0;
  for (let i = 1; i < route.stops.length; i++) {
    total += haversineKm(route.stops[i - 1]!.coords, route.stops[i]!.coords);
  }
  return total;
}

export interface NetworkStats {
  routeCount: number;
  stopCount: number;
  totalKm: number;
  /** Route count per mode, e.g. { subway: 4, bus: 12 }. */
  byType: Record<string, number>;
}

/** Aggregate stats over a set of routes (the user's live network). */
export function networkStats(routes: RouteLike[]): NetworkStats {
  const byType: Record<string, number> = {};
  let stopCount = 0;
  let totalKm = 0;
  for (const r of routes) {
    byType[r.type] = (byType[r.type] ?? 0) + 1;
    stopCount += r.stops.length;
    totalKm += routeLengthKm(r);
  }
  return { routeCount: routes.length, stopCount, totalKm: Math.round(totalKm), byType };
}
