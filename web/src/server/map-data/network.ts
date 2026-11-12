import "server-only";

/**
 * The LIVE network the AI reasons about.
 *
 * Root cause this fixes: the assistant's server tools used to read only the
 * static ROUTES/BUS_ROUTES/GO_TRAIN_ROUTES snapshot, while the user's map shows
 * their own drawn/saved lines too. The AI was verifying claims against a
 * different network than the one on screen. Now the client sends its live
 * `routes` state with each AI request (the same pattern /api/council already
 * uses for `existingLines`) and every tool queries THAT.
 */

import { ROUTES, BUS_ROUTES, GO_TRAIN_ROUTES } from "~/app/map/transit-data";
import { networkStats, type NetworkStats } from "~/lib/network-stats";
import { SpatialGrid } from "./spatial-grid";

/** Minimal route shape the client sends — everything a tool needs, nothing more. */
export interface NetRoute {
  id: string;
  name: string;
  /**
   * Badge text, e.g. "1" for Line 1 or "501" for the Queen streetcar. Optional:
   * older clients don't send it. Lets the assistant resolve "Line 1" or "the
   * 504" to a route (the names alone are just "Yonge–University", "King").
   */
  shortName?: string;
  type: string;
  stops: Array<{ name: string; coords: [number, number] }>;
}

/**
 * How a line is named to the model and the user, the way the app labels it:
 * "Line 1 Yonge–University" (subway/LRT), "501 Queen" (others with a badge),
 * or just the name for custom lines (their auto badges like "RL" add nothing).
 * Shared by the prompt's route list and the action tools, so both use the
 * same words.
 */
export function routeDisplayName(route: Pick<NetRoute, "id" | "name" | "shortName" | "type">): string {
  if (route.id.startsWith("custom-") || !route.shortName) return route.name;
  if (route.type === "subway" || route.type === "lrt") return `Line ${route.shortName} ${route.name}`;
  return `${route.shortName} ${route.name}`;
}

/** One stop flattened out of its route, for network-wide spatial queries. */
export interface NetStop {
  name: string;
  route: string;
  routeType: string;
  coords: [number, number];
}

export interface LiveNetwork {
  routes: NetRoute[];
  stops: NetStop[];
  /** Spatial index over all stops (1 km cells) — built once per request. */
  grid: SpatialGrid<NetStop>;
  stats: NetworkStats;
}

// Sanitisation caps — the payload comes from the browser, so treat it as
// untrusted: clamp sizes and drop anything that isn't a plausible coordinate.
const MAX_ROUTES = 300;
const MAX_STOPS_PER_ROUTE = 400;
const MAX_SHORT_NAME_CHARS = 20;

function asCoords(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const lng = Number(raw[0]);
  const lat = Number(raw[1]);
  // Generous sanity bounds (GO lines run beyond the Toronto bbox).
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  if (lng < -85 || lng > -70 || lat < 40 || lat > 50) return null;
  return [lng, lat];
}

function sanitizeRoutes(raw: unknown): NetRoute[] | null {
  // Missing → fall back to the static network. An explicit [] is a real state
  // (the user wiped the map via Reset → Empty map), so it must stay empty —
  // otherwise the assistant would still "see" every TTC line after a wipe.
  if (!Array.isArray(raw)) return null;
  if (raw.length === 0) return [];
  const routes: NetRoute[] = [];
  for (const r of raw.slice(0, MAX_ROUTES)) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Record<string, unknown>;
    if (typeof o.name !== "string" || !Array.isArray(o.stops)) continue;
    const stops: NetRoute["stops"] = [];
    for (const s of (o.stops as unknown[]).slice(0, MAX_STOPS_PER_ROUTE)) {
      if (typeof s !== "object" || s === null) continue;
      const so = s as Record<string, unknown>;
      const coords = asCoords(so.coords);
      if (typeof so.name !== "string" || !coords) continue;
      stops.push({ name: so.name, coords });
    }
    if (stops.length === 0) continue;
    const shortName = typeof o.shortName === "string" ? o.shortName.trim().slice(0, MAX_SHORT_NAME_CHARS) : "";
    routes.push({
      id: typeof o.id === "string" ? o.id : `route-${routes.length}`,
      name: o.name,
      // Only set when the client sent one, so routes stay minimal otherwise.
      ...(shortName ? { shortName } : {}),
      type: typeof o.type === "string" ? o.type : "bus",
      stops,
    });
  }
  return routes.length > 0 ? routes : null;
}

function staticRoutes(): NetRoute[] {
  return [...ROUTES, ...BUS_ROUTES, ...GO_TRAIN_ROUTES].map((r) => ({
    id: r.id,
    name: r.name,
    shortName: r.shortName,
    type: r.type,
    stops: r.stops.map((s) => ({ name: s.name, coords: s.coords })),
  }));
}

/**
 * Build the network for one AI request. `rawClientRoutes` is the client's live
 * map state; when absent or unusable we fall back to the static default
 * network (better than answering about nothing).
 */
export function buildNetwork(rawClientRoutes?: unknown): LiveNetwork {
  const routes = sanitizeRoutes(rawClientRoutes) ?? staticRoutes();
  const stops: NetStop[] = [];
  for (const r of routes) {
    for (const s of r.stops) {
      stops.push({ name: s.name, route: r.name, routeType: r.type, coords: s.coords });
    }
  }
  return {
    routes,
    stops,
    grid: new SpatialGrid(stops, 1),
    stats: networkStats(routes),
  };
}

/**
 * Build a network from a flat stop list — the shape the council receives as
 * `existingLines` ({name, coords, route}). Stops are regrouped into routes so
 * the same tools work for both the assistant and the council.
 */
export function networkFromStops(
  flat: Array<{ name: string; coords: [number, number]; route: string }>,
): LiveNetwork {
  const byRoute = new Map<string, NetRoute>();
  const stops: NetStop[] = [];
  for (const s of flat) {
    const coords = asCoords(s.coords);
    if (!coords || typeof s.name !== "string") continue;
    let r = byRoute.get(s.route);
    if (!r) {
      r = { id: s.route, name: s.route, type: "subway", stops: [] };
      byRoute.set(s.route, r);
    }
    r.stops.push({ name: s.name, coords });
    stops.push({ name: s.name, route: s.route, routeType: r.type, coords });
  }
  const routes = [...byRoute.values()];
  return { routes, stops, grid: new SpatialGrid(stops, 1), stats: networkStats(routes) };
}
