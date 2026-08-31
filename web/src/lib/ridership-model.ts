/**
 * THE gravity ridership model — single source of truth.
 *
 * Why this file exists: the same formula lived in two places
 * (ExperimentalPanel.tsx's forecastRidership and
 * council-ridership-tools.ts's copy of its constants) with a "keep in sync"
 * comment. That's a drift bug waiting to happen: the AI would argue for a stop
 * the UI then rates differently. Now every consumer — the Experimental panel,
 * the council's query tools, and the map assistant — imports this one module.
 *
 * 📖 Learn: a gravity model estimates demand at a place as proportional to the
 * population it can attract, attenuated by how easily people reach it. Here the
 * "reach" terms are service frequency (more vehicles ⇒ more trips) and a mode
 * multiplier (a subway pulls more riders than a bus from the same catchment).
 */

import type { Route, ServicePattern } from "~/app/map/transit-data";

/** Mode attractiveness multipliers (subway pulls 3× what a bus does). */
export const MODE_FACTORS: Record<string, number> = {
  subway: 1.5,
  lrt: 1.2,
  go_train: 0.6,
  streetcar: 1.0,
  bus: 0.5,
};
export const DEFAULT_MODE_FACTOR = 0.8;

/** Standard transit "walk-shed": riders walk ~800 m to a rapid-transit stop. */
export const DEFAULT_WALK_RADIUS_KM = 0.8;
/** A reasonable rapid-transit service level when none is specified. */
export const DEFAULT_HEADWAY_MIN = 10;

/**
 * Minutes between vehicles, parsed from a route's frequency text (e.g.
 * "4–6 min") or its structured service pattern when present.
 */
export function parseHeadway(frequency: string, servicePattern?: ServicePattern): number {
  if (servicePattern?.headwayMinutes) return servicePattern.headwayMinutes;
  const range = /(\d+)[–-](\d+)/.exec(frequency);
  if (range) return (parseInt(range[1]!) + parseInt(range[2]!)) / 2;
  const single = /(\d+)\s*min/i.exec(frequency);
  if (single) return parseInt(single[1]!);
  return 30;
}

/**
 * The core formula: dailyBoardings = catchmentPop × freqFactor × modeFactor ÷ 365.
 * 📖 Learn: dividing the annual-feeling population weight by 365 converts the
 * catchment into a *daily* boardings figure — the unit every UI panel shows.
 */
export function gravityDailyBoardings(
  catchmentPopulation: number,
  headwayMin: number,
  mode: string,
): number {
  const freqFactor = Math.max(0.1, 60 / headwayMin);
  const modeFactor = MODE_FACTORS[mode] ?? DEFAULT_MODE_FACTOR;
  return Math.round((catchmentPopulation * freqFactor * modeFactor) / 365);
}

/**
 * Whole-route daily ridership forecast (moved verbatim from
 * ExperimentalPanel.tsx so the panel and the AI tools agree).
 * `stationPop` maps station name → walk-shed population.
 */
export function forecastRouteRidership(route: Route, stationPop: Map<string, number>): number {
  const headway = parseHeadway(route.frequency, route.servicePattern);
  let pop = 0;
  for (const s of route.stops) pop += stationPop.get(s.name) ?? 0;
  // Fallback when census data hasn't loaded: assume 5k people per stop.
  if (pop === 0) pop = route.stops.length * 5000;
  return gravityDailyBoardings(pop, headway, route.type);
}
