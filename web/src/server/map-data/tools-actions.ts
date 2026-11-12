import "server-only";

/**
 * Resolvers for the Ask AI "app action" tools — view control, the commuter
 * simulation and draft lines. Their DEFINITIONS (what the model sees) live in
 * tools.ts with every other tool; this file holds what the server does when
 * the model calls one.
 *
 * Every resolver follows the same contract as the drawing tools:
 *  • validate the model's arguments against the real app state (routes in the
 *    user's plan, the census raster, the contract's enums);
 *  • on success return `rendered` with clientArgs that EXACTLY match the
 *    contract's AppAction args (the browser runs parseAppAction on them), plus
 *    a `modelNote` saying what really happened ("a draft is shown, nothing was
 *    added") so the model can't overclaim;
 *  • on failure return `rejected` with an error the model can act on
 *    (suggestions, the offending stop, the valid ids).
 *
 * Human-in-the-loop rule: nothing here changes the user's data. View actions
 * only change what is shown; propose_line only opens a confirm card.
 */

import { haversineKm } from "~/app/map/geo-utils";
import { BUS_ROUTES } from "~/app/map/transit-data";
import {
  LINE_TYPES,
  PANEL_IDS,
  TOGGLEABLE_LAYER_IDS,
  type DraftLine,
  type LineType,
  type PanelId,
  type ToggleableLayerId,
} from "~/lib/map-assistant-protocol";
import { OVERLAY_CATALOG } from "~/lib/project-knowledge";
import { computeGeometry, costBn, pathKm } from "../route-metrics";
import { runSimulationForChat } from "../simulation-api";
import type { ProposedLine } from "../simulation";
import { getTorontoRaster } from "./census";
import { cityNeighbourhoodRing, suggestCityNeighbourhoods } from "./city-neighbourhoods";
import { districtRing, TORONTO_DISTRICTS } from "./districts";
import { TORONTO_BBOX, inBBox, neighbourhoodRing } from "./geo";
import { isInhabited } from "./inhabited";
import { routeDisplayName, type NetRoute } from "./network";
import { SpatialGrid } from "./spatial-grid";
// Type-only import: erased at compile time, so there is no runtime import cycle
// with tools.ts (which imports the resolvers below).
import type { ToolContext, WriteResolution } from "./tools";

// ── Shared helpers ────────────────────────────────────────────────────────────

function reject(error: string): WriteResolution {
  return { status: "rejected", error };
}

function asPoint(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const lng = Number(raw[0]);
  const lat = Number(raw[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/** Trimmed single-line text, at most `max` characters; "" when unusable. */
function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, max);
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function formatPoint(p: [number, number]): string {
  return `[${p[0].toFixed(4)}, ${p[1].toFixed(4)}]`;
}

// ── Route-name resolution (focus, set_route_visibility) ──────────────────────

/** The few route fields name matching needs — works for plan routes and the static bus catalogue. */
export type RouteRef = Pick<NetRoute, "id" | "name" | "shortName" | "type">;

export type RouteMatch =
  | { kind: "match"; route: RouteRef }
  | { kind: "ambiguous"; candidates: RouteRef[] }
  | { kind: "none"; suggestions: RouteRef[] };

/**
 * Lower-case, accent-free, punctuation-free: "Yonge–University" → "yonge university".
 * 📖 Learn: NFKD normalisation splits "é" into "e" + a combining accent mark;
 * the Unicode property escape \p{M} ("any Mark", needs the `u` flag) then
 * deletes the marks, leaving plain letters.
 */
export function normalizeRouteText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Words that name a KIND of line rather than a specific one.
 * STRONG words must match: "hide the King Street bus" must never hide the
 * King streetcar. WEAK words only break ties, because people use them
 * loosely: TTC calls its subway/LRT routes "Line 1", but "the Queen line"
 * means the 501 streetcar.
 *
 * Maps rather than object literals on purpose: `"constructor" in {}` is true
 * (objects inherit keys), so an object lookup could "find" a type word the
 * user never typed. Map.get only sees what we put in.
 */
const STRONG_TYPE_WORDS = new Map<string, string[]>([
  ["subway", ["subway"]],
  ["lrt", ["lrt"]],
  ["streetcar", ["streetcar"]],
  ["streetcars", ["streetcar"]],
  ["bus", ["bus"]],
  ["buses", ["bus"]],
  ["go", ["go_train"]],
]);
const WEAK_TYPE_WORDS = new Map<string, string[]>([
  ["line", ["subway", "lrt"]],
  ["train", ["go_train", "subway"]],
]);
const FILLER_WORDS = new Set([
  "the",
  "route",
  "no",
  "number",
  "my",
  "new",
  ...STRONG_TYPE_WORDS.keys(),
  ...WEAK_TYPE_WORDS.keys(),
]);

/** The badge as a normalised token: shortName, or the number in ids like "line-1" / "streetcar-501" / "bus-7". */
function routeBadge(route: RouteRef): string | null {
  if (route.shortName) return normalizeRouteText(route.shortName);
  const fromId = /^(?:line|streetcar|bus)-([a-z0-9]+)$/i.exec(route.id);
  return fromId ? fromId[1]!.toLowerCase() : null;
}

function describeRouteRef(route: RouteRef): string {
  return `${routeDisplayName(route)} (${route.type}, id ${route.id})`;
}

/** One tier's candidates as a result: exactly one → match, several → ambiguous. */
function asMatch(candidates: RouteRef[]): RouteMatch {
  return candidates.length === 1
    ? { kind: "match", route: candidates[0]! }
    : { kind: "ambiguous", candidates };
}

/** Closest names for a rejection message: shared words first, the user's own lines as a fallback. */
function suggestRoutes(coreWords: string[], routes: RouteRef[], limit = 5): RouteRef[] {
  const scored = routes.map((route) => {
    const words = new Set(normalizeRouteText(`${route.name} ${route.shortName ?? ""}`).split(" "));
    let score = 0;
    for (const word of coreWords) {
      if (words.has(word)) score += 2;
      else if (word.length >= 3 && [...words].some((w) => w.startsWith(word) || word.startsWith(w))) score += 1;
    }
    return { route, score };
  });
  const hits = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  if (hits.length > 0) return hits.slice(0, limit).map((s) => s.route);
  return routes.filter((r) => r.id.startsWith("custom-")).slice(0, limit);
}

/**
 * Resolve a free-text line reference against a list of routes.
 *
 * Candidates are gathered in TIERS, most to least certain:
 *   1. exact name, or badge + name ("King", "501 Queen", "Line 1 Yonge–University")
 *   2. badge / number on its own ("Line 1" → "1", "the 504" → "504")
 *   3. the words appear in the name, or the whole name appears in the query
 *      ("Yonge line" → "Yonge–University", "504 King" → "King")
 * (An exact id like "line-1" or "custom-3" short-circuits everything.)
 *
 * Then two passes:
 *   • if the query names a KIND of line ("bus", "streetcar", "line"…), the
 *     first tier holding a candidate of that kind wins — so "Yonge line"
 *     finds Line 1 even when a "Yonge" bus is loaded;
 *   • otherwise the first non-empty tier wins — unless the kind word was a
 *     STRONG one ("bus"), in which case a line of another kind is no match.
 * Several equally good candidates come back as `ambiguous`, never a guess.
 */
export function resolveRouteQuery(query: string, routes: RouteRef[]): RouteMatch {
  const q = normalizeRouteText(query);
  if (q === "") return { kind: "none", suggestions: [] };

  const rawLower = query.trim().toLowerCase();
  const byId = routes.find((r) => r.id.toLowerCase() === rawLower);
  if (byId) return { kind: "match", route: byId };

  const words = q.split(" ");
  const strongWord = words.find((w) => STRONG_TYPE_WORDS.has(w));
  const weakWord = words.find((w) => WEAK_TYPE_WORDS.has(w));
  let preferredTypes: string[] | null = null;
  if (strongWord) preferredTypes = STRONG_TYPE_WORDS.get(strongWord)!;
  else if (weakWord) preferredTypes = WEAK_TYPE_WORDS.get(weakWord)!;
  const coreWords = words.filter((w) => !FILLER_WORDS.has(w));
  const core = coreWords.join(" ");

  const exactTier = routes.filter((r) => {
    const name = normalizeRouteText(r.name);
    const badge = routeBadge(r);
    return name === q || name === core || (badge !== null && `${badge} ${name}` === core);
  });
  const badgeTier = core === "" ? [] : routes.filter((r) => routeBadge(r) === core);
  // Three characters minimum, so "a" or "do" can't match everything.
  const containsTier =
    core.length < 3
      ? []
      : routes.filter((r) => {
          const name = normalizeRouteText(r.name);
          return name.includes(core) || ` ${core} `.includes(` ${name} `);
        });
  const tiers = [exactTier, badgeTier, containsTier];

  const suggestionWords = coreWords.length > 0 ? coreWords : words;

  if (preferredTypes) {
    for (const tier of tiers) {
      const ofKind = tier.filter((r) => preferredTypes.includes(r.type));
      if (ofKind.length > 0) return asMatch(ofKind);
    }
    // A strong kind word that no candidate has: better "no match" than the wrong line.
    if (strongWord) return { kind: "none", suggestions: suggestRoutes(suggestionWords, routes) };
  }
  for (const tier of tiers) {
    if (tier.length > 0) return asMatch(tier);
  }
  return { kind: "none", suggestions: suggestRoutes(suggestionWords, routes) };
}

/** The 208 TTC bus routes, which are drawn even when not loaded into the plan. */
const BUS_CATALOGUE: RouteRef[] = BUS_ROUTES.map((r) => ({
  id: r.id,
  name: r.name,
  shortName: r.shortName,
  type: r.type,
}));

function hiddenRouteIds(ctx: ToolContext): Set<string> {
  return new Set(ctx.ui?.network?.hiddenRouteIds ?? []);
}

// ── set_map_layers ────────────────────────────────────────────────────────────

function isToggleableLayer(value: unknown): value is ToggleableLayerId {
  return typeof value === "string" && (TOGGLEABLE_LAYER_IDS as readonly string[]).includes(value);
}

export function resolveSetMapLayers(args: Record<string, unknown>, ctx: ToolContext): WriteResolution {
  const raw = Array.isArray(args.layers) ? args.layers : [];
  if (raw.length === 0) {
    return reject("set_map_layers needs layers: [{ id, on }] with at least one entry.");
  }
  if (raw.length > 10) return reject("set_map_layers takes at most 10 layers per call.");

  // A Map keeps first-mention order; a repeated id takes its latest on/off value.
  const wanted = new Map<ToggleableLayerId, boolean>();
  const invalid: string[] = [];
  for (const item of raw) {
    const entry = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    if (isToggleableLayer(entry.id) && typeof entry.on === "boolean") wanted.set(entry.id, entry.on);
    else invalid.push(JSON.stringify(item));
  }
  if (invalid.length > 0) {
    return reject(
      `Invalid layer entries: ${invalid.join(", ")}. Each needs { id, on: true|false } with id one of: ` +
        `${TOGGLEABLE_LAYER_IDS.join(", ")}. (Travel-time areas use show_isochrone; simulation layers appear after run_simulation.)`,
    );
  }

  const wasOn = new Set((ctx.ui?.layers ?? []).filter((l) => l.on).map((l) => l.id));
  const layers = [...wanted].map(([id, on]) => ({ id, on }));
  const summary = layers
    .map(({ id, on }) => {
      const unchanged = ctx.ui && wasOn.has(id) === on ? " (it already was)" : "";
      return `${OVERLAY_CATALOG[id].label} ${on ? "ON" : "OFF"}${unchanged}`;
    })
    .join(", ");

  return {
    status: "rendered",
    clientName: "set_map_layers",
    clientArgs: { layers },
    modelNote: `Layers switched: ${summary}. View only — nothing in the plan changed.`,
  };
}

// ── show_isochrone ────────────────────────────────────────────────────────────

const ISOCHRONE_MINUTES = [15, 30, 45, 60] as const;
const ISOCHRONE_MODES = ["walking", "cycling", "driving"] as const;
type IsochroneMinutes = (typeof ISOCHRONE_MINUTES)[number];
type IsochroneMode = (typeof ISOCHRONE_MODES)[number];

/** The supported value closest to `requested` (ties go to the longer time, so the area isn't undersold). */
function nearestIsochroneMinutes(requested: number): IsochroneMinutes {
  let best: IsochroneMinutes = 30;
  let bestDiff = Infinity;
  for (const option of ISOCHRONE_MINUTES) {
    const diff = Math.abs(option - requested);
    if (diff <= bestDiff) {
      best = option;
      bestDiff = diff;
    }
  }
  return best;
}

export function resolveShowIsochrone(args: Record<string, unknown>): WriteResolution {
  if (args.clear === true) {
    return {
      status: "rendered",
      clientName: "show_isochrone",
      clientArgs: { clear: true },
      modelNote: "The isochrone was removed from the map.",
    };
  }

  const origin = asPoint(args.origin);
  if (!origin) {
    return reject("show_isochrone needs origin as [longitude, latitude] (or clear: true to remove the current one).");
  }
  if (!inBBox(origin[0], origin[1], TORONTO_BBOX)) {
    return reject(`Isochrone origin ${formatPoint(origin)} is outside the Toronto area — fetch a real point with describe_location first.`);
  }

  let mode: IsochroneMode = "walking";
  if (args.mode !== undefined) {
    if (!(ISOCHRONE_MODES as readonly unknown[]).includes(args.mode)) {
      return reject(`show_isochrone mode must be one of: ${ISOCHRONE_MODES.join(", ")} (transit isn't supported).`);
    }
    mode = args.mode as IsochroneMode;
  }

  // Why snap instead of reject: the map can only draw 15/30/45/60-minute bands,
  // and "20 minutes" has an obvious nearest answer — a rejection would cost a
  // whole extra model round trip for no benefit. The note tells the model.
  let minutes: IsochroneMinutes = 30;
  let snappedNote = "";
  const requested = typeof args.minutes === "number" && Number.isFinite(args.minutes) ? args.minutes : null;
  if (requested !== null) {
    minutes = nearestIsochroneMinutes(requested);
    if (minutes !== requested) {
      snappedNote = ` The map only supports 15, 30, 45 or 60 minutes, so ${minutes} was used instead of ${requested}.`;
    }
  }

  return {
    status: "rendered",
    clientName: "show_isochrone",
    clientArgs: { origin, minutes, mode },
    modelNote:
      `Showing the area reachable within ${minutes} min ${mode} from ${formatPoint(origin)} — nested bands ` +
      `(15 green, 30 amber, 45 red, 60 purple) up to ${minutes} min, computed by Mapbox in the browser.${snappedNote}`,
  };
}

// ── focus ─────────────────────────────────────────────────────────────────────

/** [west, south, east, north] of a polygon ring. */
function ringBBox(ring: [number, number][]): [number, number, number, number] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  for (const [lng, lat] of ring) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [round(west, 5), round(south, 5), round(east, 5), round(north, 5)];
}

function focusRoute(name: string, ctx: ToolContext): WriteResolution {
  const result = resolveRouteQuery(name, ctx.network.routes);

  if (result.kind === "ambiguous") {
    return reject(
      `"${name}" matches several lines: ${result.candidates.map(describeRouteRef).join("; ")}. Call focus again with the exact id.`,
    );
  }
  if (result.kind === "none") {
    // A real TTC bus route that just isn't loaded into the plan gets a specific answer.
    const bus = resolveRouteQuery(name, BUS_CATALOGUE);
    if (bus.kind === "match") {
      return reject(
        `${routeDisplayName(bus.route)} is a TTC bus route that is not loaded into the user's plan, so it can't be selected. ` +
          `Tell the user: Lines panel → Bus → click it to load it. (set_route_visibility can still draw it.)`,
      );
    }
    const suggestions = result.suggestions.map(describeRouteRef).join("; ");
    return reject(
      `No line in the user's plan matches "${name}".` +
        (suggestions ? ` Closest: ${suggestions}.` : "") +
        " The plan's routes (with ids) are listed in the request context.",
    );
  }

  const route = result.route;
  const display = routeDisplayName(route);
  const hiddenNote = hiddenRouteIds(ctx).has(route.id)
    ? " It is currently hidden in the Lines panel — offer to show it (set_route_visibility)."
    : "";
  return {
    status: "rendered",
    clientName: "focus",
    clientArgs: { target: "route", routeId: route.id, routeName: display },
    modelNote: `Selected ${display}: the map moves to it and its Route panel opens.${hiddenNote}`,
  };
}

function focusNeighbourhood(name: string): WriteResolution {
  // Same lookup order as show_area: the official 158 neighbourhoods (forgiving
  // name match), then the legacy downtown catalogue, then the six former boroughs.
  const hood = cityNeighbourhoodRing(name) ?? neighbourhoodRing(name) ?? districtRing(name);
  if (!hood) {
    const suggestions = suggestCityNeighbourhoods(name);
    const districts = TORONTO_DISTRICTS.map((d) => d.name).join(", ");
    return reject(
      `No unique match for neighbourhood '${name}'.` +
        (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
        ` Former boroughs also work: ${districts}.`,
    );
  }
  return {
    status: "rendered",
    clientName: "focus",
    clientArgs: { target: "neighbourhood", name: hood.name, bbox: ringBBox(hood.ring) },
    modelNote: `The map moved to ${hood.name}.`,
  };
}

export function resolveFocus(args: Record<string, unknown>, ctx: ToolContext): WriteResolution {
  const name = cleanText(args.name, 80);
  if (name === "") return reject("focus needs a name (a line's name, badge or id, or a neighbourhood).");
  if (args.target === "route") return focusRoute(name, ctx);
  if (args.target === "neighbourhood") return focusNeighbourhood(name);
  return reject("focus target must be 'route' or 'neighbourhood'.");
}

// ── set_route_visibility ──────────────────────────────────────────────────────

export function resolveSetRouteVisibility(args: Record<string, unknown>, ctx: ToolContext): WriteResolution {
  if (typeof args.visible !== "boolean") return reject("set_route_visibility needs visible: true (show) or false (hide).");
  const queries = Array.isArray(args.routes) ? args.routes.map((r) => cleanText(r, 80)).filter((r) => r !== "") : [];
  if (queries.length === 0) return reject("set_route_visibility needs routes: a list of line names, badges or ids.");
  if (queries.length > 30) return reject("set_route_visibility takes at most 30 lines per call.");

  const resolved: RouteRef[] = [];
  const unloadedBuses: RouteRef[] = [];
  const problems: string[] = [];

  for (const query of queries) {
    const inPlan = resolveRouteQuery(query, ctx.network.routes);
    if (inPlan.kind === "match") {
      resolved.push(inPlan.route);
      continue;
    }
    if (inPlan.kind === "ambiguous") {
      problems.push(`"${query}" matches several lines: ${inPlan.candidates.map(describeRouteRef).join("; ")}`);
      continue;
    }
    // Not in the plan: a TTC bus route can still be drawn or hidden (the Lines
    // panel's eye icon does exactly this) — it just won't count in measures.
    const bus = resolveRouteQuery(query, BUS_CATALOGUE);
    if (bus.kind === "match") {
      resolved.push(bus.route);
      unloadedBuses.push(bus.route);
      continue;
    }
    const suggestions = inPlan.suggestions.map(describeRouteRef).join("; ");
    problems.push(`no line matches "${query}"${suggestions ? ` (closest: ${suggestions})` : ""}`);
  }

  if (problems.length > 0) {
    return reject(`Nothing was changed: ${problems.join(". ")}. Retry with exact names or ids from the route list.`);
  }

  // De-duplicate ("Line 1" and "line-1" in the same call).
  const routeIds: string[] = [];
  const names: string[] = [];
  for (const route of resolved) {
    if (routeIds.includes(route.id)) continue;
    routeIds.push(route.id);
    names.push(routeDisplayName(route));
  }

  const busNote =
    unloadedBuses.length > 0 && args.visible
      ? ` ${unloadedBuses.map(routeDisplayName).join(", ")} ${unloadedBuses.length === 1 ? "is" : "are"} only drawn — not loaded into the plan, so measures still ignore ${unloadedBuses.length === 1 ? "it" : "them"} (Lines panel → Bus → click to load).`
      : "";

  return {
    status: "rendered",
    clientName: "set_route_visibility",
    clientArgs: { routeIds, visible: args.visible },
    modelNote:
      `${args.visible ? "Shown" : "Hidden"}: ${names.join(", ")}. View only — hidden lines stay in the plan and still count in every measure.` +
      busNote,
  };
}

// ── open_panel ────────────────────────────────────────────────────────────────

export function resolveOpenPanel(args: Record<string, unknown>, ctx: ToolContext): WriteResolution {
  if (!(PANEL_IDS as readonly unknown[]).includes(args.panel)) {
    return reject(`open_panel panel must be one of: ${PANEL_IDS.join(", ")}.`);
  }
  const panel = args.panel as PanelId;

  let modelNote: string;
  if (panel === "simulation") {
    modelNote = "The Simulate panel is open. It only runs when the user presses Run (or when you call run_simulation).";
  } else if (panel === "plans") {
    modelNote =
      ctx.ui?.signedIn === false
        ? "The Plans panel is open, but the user isn't signed in — it shows a Sign in button first."
        : "The Plans panel is open (saved plans; Save new plan / Update).";
  } else if (panel === "analysis") {
    modelNote = "The Analysis panel is open (20 analysis cards plus Game Mode).";
  } else {
    modelNote = "The side panels (Simulate, Plans, Analysis) are closed.";
  }

  return { status: "rendered", clientName: "open_panel", clientArgs: { panel }, modelNote };
}

// ── run_simulation ────────────────────────────────────────────────────────────

/** The chat runs a lighter simulation than the panel (500–10,000) so a turn stays fast. */
export const CHAT_SIM_AGENTS = { min: 100, max: 1000, default: 500 } as const;

export async function resolveRunSimulation(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<WriteResolution> {
  let agentCount: number = CHAT_SIM_AGENTS.default;
  if (typeof args.agents === "number" && Number.isFinite(args.agents)) {
    agentCount = Math.min(CHAT_SIM_AGENTS.max, Math.max(CHAT_SIM_AGENTS.min, Math.round(args.agents)));
  }

  // Exactly the Simulate panel's rule: proposals are the lines whose id starts
  // with "custom-" (drawn with New Line or added by the council). Lines with
  // fewer than 2 stops can't carry a trip, so they are left out (and reported).
  const customLines = ctx.network.routes.filter((r) => r.id.startsWith("custom-"));
  const usable = customLines.filter((r) => r.stops.length >= 2);
  const skipped = customLines.filter((r) => r.stops.length < 2).map((r) => r.name);
  const proposedLines: ProposedLine[] = usable.map((r) => ({
    name: r.name,
    type: r.type,
    stops: r.stops.map((s) => ({ name: s.name, coords: s.coords })),
  }));

  try {
    const { apiResult, summary } = await runSimulationForChat({
      proposedLines,
      agentCount,
      signal: ctx.signal,
    });
    return {
      status: "rendered",
      clientName: "show_simulation",
      clientArgs: { result: apiResult },
      modelNote: "The results are now shown in the Simulate panel (Overview, Equity and Stress tabs).",
      modelData: skipped.length > 0 ? { ...summary, skippedLinesWithUnder2Stops: skipped } : summary,
    };
  } catch (e) {
    if (ctx.signal?.aborted) return reject("The simulation was cancelled because the request ended.");
    console.warn("[map-data/tools-actions] run_simulation failed:", e);
    const message = e instanceof Error ? e.message : String(e);
    return reject(`The simulation failed (${message}). Tell the user they can run it from the Simulate panel instead.`);
  }
}

// ── propose_line ──────────────────────────────────────────────────────────────

/** Consecutive-stop spacing the draft must respect (contract with the prompt's guidance). */
export const DRAFT_SPACING_KM = { min: 0.25, max: 6 } as const;
export const DRAFT_STOP_LIMITS = { min: 2, max: 40 } as const;
/** Two stops closer than this are the same place (a duplicate), even if not consecutive. */
const DUPLICATE_STOP_KM = 0.05;

/** Default colour per mode (matches the corridor colours the assistant already draws). */
export const DRAFT_DEFAULT_COLORS: Record<LineType, string> = {
  subway: "#6366f1",
  lrt: "#8b5cf6",
  streetcar: "#f59e0b",
  bus: "#10b981",
};

/**
 * Walk-shed radius per mode — the same cutoffs as the Route panel's
 * "Population Served" (TransitMap stationPopulations): 0.8 km rapid transit,
 * 0.5 km streetcar/bus.
 */
const DRAFT_WALK_KM: Record<LineType, number> = { subway: 0.8, lrt: 0.8, streetcar: 0.5, bus: 0.5 };

/**
 * Census population within walking distance of the draft — a UNION (each
 * block counted once, like populationServedByNetwork), plus how much of it
 * the user's current plan does NOT already reach. null when census data is
 * unavailable.
 */
async function draftCatchment(
  stops: Array<{ coords: [number, number] }>,
  walkKm: number,
  ctx: ToolContext,
): Promise<{ populationServed: number; newPopulationReached: number } | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null;
  const draftGrid = new SpatialGrid(stops, 1);
  let served = 0;
  let newlyServed = 0;
  for (const block of raster.blocks) {
    if (!draftGrid.nearest(block.coords, walkKm)) continue;
    served += block.population;
    if (!ctx.network.grid.nearest(block.coords, walkKm)) newlyServed += block.population;
  }
  return { populationServed: Math.round(served), newPopulationReached: Math.round(newlyServed) };
}

export async function resolveProposeLine(args: Record<string, unknown>, ctx: ToolContext): Promise<WriteResolution> {
  const name = cleanText(args.name, 60);
  if (name === "") return reject("propose_line needs a name for the line.");

  if (!(LINE_TYPES as readonly unknown[]).includes(args.type)) {
    return reject(`propose_line type must be one of: ${LINE_TYPES.join(", ")}.`);
  }
  const type = args.type as LineType;

  const rawStops = Array.isArray(args.stops) ? args.stops : [];
  if (rawStops.length < DRAFT_STOP_LIMITS.min || rawStops.length > DRAFT_STOP_LIMITS.max) {
    return reject(`propose_line needs ${DRAFT_STOP_LIMITS.min}–${DRAFT_STOP_LIMITS.max} stops (got ${rawStops.length}).`);
  }

  // 1. Shape of each stop + inside Toronto.
  const stops: DraftLine["stops"] = [];
  for (let i = 0; i < rawStops.length; i++) {
    const raw = typeof rawStops[i] === "object" && rawStops[i] !== null ? (rawStops[i] as Record<string, unknown>) : {};
    const stopName = cleanText(raw.name, 60);
    const coords = asPoint(raw.coords);
    if (stopName === "" || !coords) {
      return reject(`Stop ${i + 1} needs a name and coords as [longitude, latitude].`);
    }
    if (!inBBox(coords[0], coords[1], TORONTO_BBOX)) {
      return reject(`Stop ${i + 1} "${stopName}" ${formatPoint(coords)} is outside the Toronto area.`);
    }
    stops.push({ name: stopName, coords: [round(coords[0], 6), round(coords[1], 6)] });
  }

  // 2. No duplicates — same name, or the same spot (within 50 m), anywhere on the line.
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const a = stops[i]!;
      const b = stops[j]!;
      if (a.name.toLowerCase() === b.name.toLowerCase()) {
        return reject(`Stops ${i + 1} and ${j + 1} are both named "${a.name}" — each stop must be distinct.`);
      }
      if (haversineKm(a.coords, b.coords) < DUPLICATE_STOP_KM) {
        return reject(`Stops ${i + 1} "${a.name}" and ${j + 1} "${b.name}" are at the same spot — remove one.`);
      }
    }
  }

  // 3. Consecutive spacing.
  for (let i = 1; i < stops.length; i++) {
    const km = haversineKm(stops[i - 1]!.coords, stops[i]!.coords);
    if (km < DRAFT_SPACING_KM.min || km > DRAFT_SPACING_KM.max) {
      return reject(
        `Stops ${i} "${stops[i - 1]!.name}" → ${i + 1} "${stops[i]!.name}" are ${km.toFixed(2)} km apart; ` +
          `consecutive stops must be ${DRAFT_SPACING_KM.min}–${DRAFT_SPACING_KM.max} km apart. ` +
          (km < DRAFT_SPACING_KM.min ? "Drop or move one of them." : "Add a stop in between."),
      );
    }
  }

  // 4. Travel order: a line that doubles back or crosses itself means the
  //    stops were listed out of order (route-metrics measures both).
  const geometry = computeGeometry(stops, { minKm: DRAFT_SPACING_KM.min, maxKm: DRAFT_SPACING_KM.max });
  if (geometry.reversals > 0 || geometry.selfIntersections > 0) {
    return reject(
      "The stops are not in travel order — the line doubles back or crosses itself. List them in the order a rider would pass them.",
    );
  }

  // 5. On land where people live (the same raster check as drop_pin). Unknown
  //    (census down) is not a failure.
  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]!;
    if ((await isInhabited(stop.coords)) === false) {
      return reject(
        `Stop ${i + 1} "${stop.name}" ${formatPoint(stop.coords)} is over water or uninhabited land — fetch a real coordinate with describe_location or query_population first.`,
      );
    }
  }

  // Stats — length and cost from route-metrics (the documented single source
  // of truth for cost), population from the census raster.
  const lengthKm = pathKm(stops);
  const catchment = await draftCatchment(stops, DRAFT_WALK_KM[type], ctx);
  const stats: DraftLine["stats"] = {
    lengthKm: round(lengthKm, 1),
    stopCount: stops.length,
    avgSpacingKm: round(lengthKm / (stops.length - 1), 2),
    ...(catchment ? { populationServed: catchment.populationServed } : {}),
    estCostBillions: round(costBn(lengthKm, stops.length, type), 2),
  };

  const color =
    typeof args.color === "string" && /^#[0-9a-fA-F]{6}$/.test(args.color) ? args.color : DRAFT_DEFAULT_COLORS[type];
  const rationale = cleanText(args.rationale, 300);

  const draft: DraftLine = {
    // 📖 Learn: crypto.randomUUID() is built into Node 19+ and browsers — a
    // random 128-bit id, so the confirm card and the map preview can refer to
    // the same draft without any server-side storage.
    draftId: crypto.randomUUID(),
    name,
    type,
    color,
    stops,
    stats,
    ...(rationale ? { rationale } : {}),
  };

  return {
    status: "rendered",
    clientName: "propose_line",
    clientArgs: draft as unknown as Record<string, unknown>,
    modelNote:
      "A draft is shown on the map with a confirm card. NOTHING has been added yet — the user must click 'Add to map'.",
    modelData: {
      ...stats,
      walkRadiusKm: DRAFT_WALK_KM[type],
      ...(catchment
        ? { newPopulationReached: catchment.newPopulationReached }
        : { populationNote: "census data unavailable — population not measured; don't estimate it" }),
      costMethod: "route-metrics capital estimate: km × per-km cost + stations × per-station cost",
    },
  };
}
