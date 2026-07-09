/**
 * Stop identity — the single place that answers "which stop is this?".
 *
 * Why this file exists: every stop operation in the app used to address stops
 * by `name`, which treats the name as a primary key. It isn't one. TTC names
 * stops "<Street> at <Cross-street>", so a single route can legitimately carry
 * the same name twice (bus-132 has "715 Milner Ave" at two points 282 m apart),
 * and two routes running the same road share names wholesale. Under name
 * addressing, deleting one stop removed a different one, dragging one moved
 * both, and unrelated stops 30 km apart were reported as transfers.
 *
 * `Stop.id` is now the key. Name is cosmetic — it can be edited, duplicated, or
 * left blank without any operation losing track of which stop it meant.
 */

// Structural types rather than importing Route/Stop from transit-data.ts. Same
// convention as network-stats.ts: it keeps this module importable from both
// client components and server code, and avoids an import cycle (transit-data
// imports *from here* to id its own literals).
type StopLike = { id?: string; name: string; coords: [number, number] };
type RouteLike<S extends StopLike = StopLike> = { id: string; stops: S[] };

/**
 * Fresh id for a user-created stop.
 *
 * 📖 Learn: crypto.randomUUID() is available in browsers over HTTPS/localhost
 * and in Node 19+, but not on insecure origins — hence the fallback. We only
 * need uniqueness within one plan, not global uniqueness.
 */
export function newStopId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `stop-${crypto.randomUUID()}`;
  }
  return `stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Assign ids to the built-in transit data at module load.
 *
 * Positional (`<routeId>-s<index>`) rather than random on purpose: these arrays
 * are literals rebuilt identically on every load and never mutated in place
 * (edits happen on copies held in React state), so the same stop gets the same
 * id in every session. That keeps ids in saved plans meaningful after a reload.
 * Never use this for stops that can be inserted or removed — see newStopId().
 */
export function withPositionalStopIds<S extends StopLike, R extends RouteLike<S>>(
  routes: R[],
): R[] {
  return routes.map((route) => ({
    ...route,
    stops: route.stops.map((stop, i) => (stop.id ? stop : { ...stop, id: `${route.id}-s${i}` })),
  }));
}

/**
 * Backfill ids on routes arriving from outside the app — saved plans written
 * before stop ids existed, GTFS/JSON imports, shared links, AI-generated routes.
 *
 * Idempotent: stops that already carry an id keep it, so re-running this on
 * already-normalised routes is a no-op. Call it at every boundary where routes
 * enter component state, so nothing downstream ever has to handle a missing id.
 */
export function withStopIds<S extends StopLike, R extends RouteLike<S>>(routes: R[]): R[] {
  return routes.map((route) => ({
    ...route,
    stops: route.stops.map((stop) => (stop.id ? stop : { ...stop, id: newStopId() })),
  }));
}

/** Metres below which two stops on different routes count as one station. */
export const TRANSFER_RADIUS_KM = 0.05;

/** Great-circle distance in km. Duplicated from geo-utils to keep this module dependency-free. */
function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(x));
}

/**
 * Are these two stops (on different routes) the same physical station?
 *
 * Name equality alone is not enough — it produced 853 false transfers in the
 * built-in data, including "Eglinton" on Line 1 vs. a GO station 13.9 km away.
 * Requiring co-location as well is what makes a shared name meaningful.
 */
export function isSameStation(a: StopLike, b: StopLike): boolean {
  return a.name === b.name && haversineKm(a.coords, b.coords) <= TRANSFER_RADIUS_KM;
}

/**
 * Key for a transfer the user has explicitly dismissed.
 *
 * Route ids are sorted so the pair is order-independent — dismissing the link
 * from A's popup must also hide it when viewing B. Shared by TransitMap (which
 * owns the Set) and RoutePanel (which reads it), so the two can't drift.
 */
export function transferExclusionKey(routeAId: string, routeBId: string, stopName: string): string {
  return [routeAId, routeBId].sort().join(":") + ":" + stopName;
}

/**
 * Every stop on *other* routes that is the same physical station as `stop`.
 *
 * This is the definition behind the popup's "Connections" list, "remove from
 * all lines", and cross-line rename — so all three agree on what a transfer is.
 * `isExcluded` lets the caller drop pairs the user has explicitly dismissed.
 */
export function transferCounterparts<S extends StopLike, R extends RouteLike<S>>(
  routes: R[],
  sourceRouteId: string,
  stop: StopLike,
  isExcluded?: (routeId: string) => boolean,
): { route: R; stop: S }[] {
  const out: { route: R; stop: S }[] = [];
  for (const route of routes) {
    if (route.id === sourceRouteId) continue;
    if (isExcluded?.(route.id)) continue;
    const match = route.stops.find((s) => isSameStation(s, stop));
    if (match) out.push({ route, stop: match });
  }
  return out;
}
