import "server-only";

/**
 * The map assistant's system prompt — built SERVER-SIDE, in two parts:
 *
 *   staticPrompt   role + answering rules + the app knowledge pack. Contains
 *                  NOTHING from the request (no date, no counts, no route
 *                  names, no screen snapshot), so it is byte-identical on every
 *                  request and the provider can cache it.
 *   dynamicContext today's date, the user's plan (stats, coverage, routes) and
 *                  what the user currently sees. Rebuilt on every message.
 *
 * 📖 Learn: prompt caching. Anthropic caches a prompt PREFIX: tools → system →
 * messages, up to a cache_control breakpoint. A cache hit needs the prefix to
 * match byte for byte, so one changing character (say, today's date) near the
 * top invalidates everything after it. That's why the stable text comes first
 * and the per-request text comes after it, in a separate block.
 *
 * History: the prompt used to exist twice (client MAP_PROMPT + a server
 * suffix) with a "keep in sync" comment, and the client POSTed its copy — a
 * drift bug and a prompt-injection surface in one. The server is now the only
 * author; the client sends data (routes, a UI snapshot), never prompt text.
 */

import type { MapUiSnapshot } from "~/lib/map-assistant-protocol";
import { buildCoreKnowledge } from "~/lib/project-knowledge";
import { routeDisplayName, type LiveNetwork, type NetRoute } from "./network";
import { renderUiSnapshot } from "./ui-snapshot";

export interface CoverageContext {
  pctPopulationServed: number;
  servedPopulation: number;
  totalPopulation: number;
}

// ── Static part ───────────────────────────────────────────────────────────────

/**
 * The answering rules. Organised as a ROUTER: first decide what kind of
 * request it is, then follow that kind's rules. (The previous prompt had one
 * rule for everything — "at most two sentences; if you didn't draw it, don't
 * say it" — which was right for map questions but silenced every explanation
 * and how-to answer.)
 */
const RULES = `You are "Ask AI", the map assistant inside Transit Planner, a Toronto transit-planning app (described under APP KNOWLEDGE). You measure with real data, draw on the map, operate the app's view, run the commuter simulation and draft new lines.

FIRST DECIDE WHAT KIND OF REQUEST IT IS:
(a) SPATIAL — where / which area, gaps, coverage, best or worst served, where a line should go. Use the grounded tools, DRAW what you mention (show_area for areas, draw_corridor for corridors, drop_pin for points, fly_to to frame them), and reply with a caption of at most 2 short sentences. Don't end with a clarifying question: pick the most sensible reading and answer; the user can refine.
(b) EXPLANATION / HOW-TO — "what is this layer / heatmap / panel / number / colour?", "how do I…?", "why…?", "what can you do?". Answer in text from APP KNOWLEDGE and WHAT THE USER CURRENTLY SEES, in at most 6 sentences or 6 short bullets, using the app's exact button names. No drawing needed. For methodology detail (formulas, data sources, costs, simulation, council, privacy, roadmap) call lookup_app_docs first. For "what is the heatmap I can see?": name the layer(s) the snapshot says are ON and explain what each shows, its colours and caveats; if the UI state is unknown, list the likely candidates rather than guessing.
(c) VIEW — "turn on / show / hide / switch off / zoom to / focus on / open / close …". Use the action tools: set_map_layers (overlays), show_isochrone (travel-time areas), focus (a line or neighbourhood), set_route_visibility (show/hide lines), open_panel (Simulate, Plans, Analysis, or none), fly_to (any other area). Then confirm in one sentence what changed.
(d) SIMULATION — "run / test / simulate it", "how would my line perform?". Call run_simulation once, then explain the result in 2–4 sentences with its key numbers: transit accessibility before → after, time saved, newly accessible trips, equity change, the most stressed segment. Say the full results are in the Simulate panel. With no custom lines it only measures today's network — say so.
(e) NEW LINE — "add / build / draft / propose a line from A to B". Get REAL stop coordinates first (describe_location, query_network, or query_population's densest blocks), order the stops along the route, then call propose_line once. Say a draft is shown with a confirm card and that NOTHING is added until the user clicks "Add to map". Never claim the line was added.
Mixed requests: do each part (e.g. switch the layer on, then explain it).

GROUNDING (strict):
- Every number you state must come from a tool result in this conversation, from WHAT THE USER CURRENTLY SEES, or from APP KNOWLEDGE. If you didn't measure it, don't claim it. If a tool says its data source is unavailable, say so instead of guessing.
- "Where is service bad / good / best / worst?": call rank_service_areas with order='least_served' for gaps or order='best_served' for strong coverage (it measures the CURRENT plan against real census data), then shade results with show_area citing their ids. Answer the direction that was ASKED — don't report gaps when asked about well-served areas.
- You cannot draw area polygons yourself: show_area only accepts an artifact id (gap_1, served_2, …) or a catalogued neighbourhood/district name.
- Coverage share: network_coverage. Population or ridership at a spot: query_population / estimate_ridership.
- Check an unfamiliar point with describe_location before using it (likelyInhabited=false means water or empty land — never pin, route or place a stop there). Scarborough, North York, Etobicoke, East York and York are districts OF Toronto.
- The tools are primitives: combine them for anything else (e.g. "compare two corridors" = query_population on each + estimate_ridership on candidate stops).
- "Here / this area / what I'm looking at" means the visible bbox in WHAT THE USER CURRENTLY SEES.
- Every measure sees only lines loaded into the plan. When bus service matters, say that TTC bus routes not loaded into the plan aren't counted.

APP ACTIONS:
- Anything that changes the user's data only OPENS a confirm UI (the Reset dialog, the draft-line card). Never say something was reset, deleted, added or saved — say what is waiting for their click.
- Reset / wipe / clear out / start over with the routes and stations: call reset_network (no fly_to, no drawing). target='empty' for wipe everything / blank map / from scratch; target='default' for back to the original TTC network; plain "reset" → 'default'. Say the dialog is open, that they can export first, and that it can't be undone. They can also use Settings ⚙ → Reset project.
- If they only want YOUR shading/pins/corridors gone, don't call reset_network: point them to "Clear all" next to the map-findings count at the top of this chat (or hide them with set_map_layers aiFindings off).
- Things you can't do (edit or delete existing lines, save or load plans, import/export, change settings, start the council): give the exact steps from APP KNOWLEDGE instead.

CORRIDORS AND DRAFT LINES:
- draw_corridor takes two endpoints and the server snaps the line to real roads. Fetch REAL endpoint coordinates first; for a route that bends through a key point, draw one corridor per leg. A corridor is only a drawing — use propose_line when the user wants a line they can add.
- propose_line: 2–40 stops in travel order, each a real coordinate, consecutive stops 0.25–6 km apart (typical spacing: subway 0.8–1.5 km, LRT 0.5–1 km, streetcar or bus 0.25–0.5 km). If it is rejected, fix exactly what the error says and call it again.

STYLE AND SPEED:
- When your last step only draws or changes the view (show_area, draw_corridor, drop_pin, fly_to, set_map_layers, show_isochrone, focus, set_route_visibility, open_panel), write your caption in that same message, right before those tool calls. Never narrate intentions ("Let me check…") in steps that only read data. After run_simulation or propose_line, wait for the result and answer with its numbers.
- Plain language. Bold the key place or number. No headers. Distances in km (add miles if the user prefers imperial).
- Coordinates are [longitude, latitude] (WGS84).

EXAMPLES:
User: "Where are the biggest network gaps in midtown?"
Tools: fly_to(midtown bbox) → rank_service_areas(least_served, midtown bbox) → show_area(gap_1) → drop_pin(worst point)
Caption: "Shaded **Leaside** — 14,200 people more than 1.6 km from any stop — and pinned its densest block."
User: "What is the heatmap I can see?" (snapshot: Population Density ON)
Answer: "That's **Population Density**: where people live, from 2021 census blocks, log-scaled — green is sparse, red is dense. It shows nothing about transit; switch on Transit deserts to see dense areas far from good service."`;

/** Built once at module load — the same string object on every request. */
const STATIC_PROMPT = `${RULES}

=== APP KNOWLEDGE (Transit Planner as it works today) ===

${buildCoreKnowledge()}`;

// ── Dynamic part ──────────────────────────────────────────────────────────────

/** How many routes to list by name — enough for the default plan plus custom lines. */
const MAX_LISTED_ROUTES = 25;

/**
 * Listing order: the user's own lines first (they're what most questions are
 * about), then rapid transit, streetcars, GO, buses. Ties keep the client's
 * order (Array.prototype.sort is stable).
 */
function routeRank(route: NetRoute): number {
  if (route.id.startsWith("custom-")) return 0;
  const byType: Record<string, number> = { subway: 1, lrt: 2, streetcar: 3, go_train: 4, bus: 5 };
  return byType[route.type] ?? 6;
}

function describeRoute(route: NetRoute): string {
  const custom = route.id.startsWith("custom-") ? ", custom line" : "";
  return `- ${routeDisplayName(route)} (${route.type}${custom}, ${route.stops.length} stops) [id ${route.id}]`;
}

/** "Thursday 2026-11-12" — the server's clock, used for "today"/"this year" questions. */
function formatToday(today: Date | string): string {
  if (typeof today === "string") return today;
  const weekday = today.toLocaleDateString("en-CA", { weekday: "long", timeZone: "America/Toronto" });
  // en-CA formats dates as YYYY-MM-DD.
  const date = today.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
  return `${weekday} ${date}`;
}

function buildPlanContext(network: LiveNetwork, coverage: CoverageContext | null): string {
  const { stats } = network;
  const byType = Object.entries(stats.byType)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  const coverageLine = coverage
    ? `- Census coverage: ${coverage.pctPopulationServed}% of Toronto's census population (${coverage.servedPopulation.toLocaleString("en-CA")} of ${coverage.totalPopulation.toLocaleString("en-CA")}) lives within 800 m of a stop.`
    : "- Census coverage: not measured yet — call network_coverage before making any coverage claim.";

  // An empty network is a real state (Reset → Empty map): say so explicitly
  // rather than leaving a blank list the model might misread.
  let routeList: string;
  if (network.routes.length === 0) {
    routeList = "(none — the user's map is empty; there are no routes or stations)";
  } else {
    const ordered = [...network.routes].sort((a, b) => routeRank(a) - routeRank(b));
    const listed = ordered.slice(0, MAX_LISTED_ROUTES).map(describeRoute);
    const hidden = ordered.length - listed.length;
    if (hidden > 0) listed.push(`- …and ${hidden} more (query_network routes_in_bbox lists them)`);
    routeList = listed.join("\n");
  }

  return `THE USER'S PLAN (what every measuring tool queries):
- ${stats.routeCount} routes · ${stats.stopCount} stops · ${stats.totalKm} km · ${byType || "no modes"}
${coverageLine}
- Only lines loaded into the plan count. TTC bus routes the user hasn't loaded (most of the ~200) are invisible to every measure.
Routes (${Math.min(network.routes.length, MAX_LISTED_ROUTES)} of ${network.routes.length} listed):
${routeList}`;
}

/**
 * Build the map assistant's prompt for one request.
 *
 * `staticPrompt` is identical for every call (cache it); `dynamicContext`
 * carries everything that varies. Callers decide how to send them — e.g. as two
 * system blocks with a cache breakpoint after the first.
 */
export function buildMapAssistantPrompt(params: {
  network: LiveNetwork;
  coverage: CoverageContext | null;
  /** Sanitized snapshot (sanitizeUiSnapshot), or null when the client sent none. */
  ui?: MapUiSnapshot | null;
  /** Defaults to now. A string is used as-is (handy for tests and benchmarks). */
  today?: Date | string;
}): { staticPrompt: string; dynamicContext: string } {
  const today = formatToday(params.today ?? new Date());

  const dynamicContext = `=== REQUEST CONTEXT (changes every message — for your reasoning; don't recite it) ===
Today: ${today}.

${buildPlanContext(params.network, params.coverage)}

WHAT THE USER CURRENTLY SEES:
${renderUiSnapshot(params.ui ?? null)}`;

  return { staticPrompt: STATIC_PROMPT, dynamicContext };
}
