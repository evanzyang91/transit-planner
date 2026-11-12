/**
 * THE single source of truth about the Transit Planner app itself — what is on
 * screen, how to do things, what every layer means, and how each number is
 * computed. Two consumers read it:
 *
 *   • the Ask AI map assistant (server/map-data/prompt.ts) — the CORE tier is
 *     always in its system prompt; the LOOKUP tier is fetched on demand with
 *     the `lookup_app_docs` tool;
 *   • the /docs chat (app/api/docs-chat/route.ts) — gets everything.
 *
 * Why one module: the docs used to exist three times (docs-content.ts and the
 * two JSX docs pages) and all three drifted away from the app — wrong council
 * roster, missing layers, a "bottom toolbar" that moved. Facts here were
 * checked against the CODE on 2026-11-12, and where the code and older docs
 * disagree, the code wins. Known bugs are described as they behave today,
 * not as intended (an assistant that explains the intended behaviour of a
 * buggy layer is worse than useless).
 *
 * Client-safe on purpose (no server-only imports): the overlay catalogue can
 * also label things in the browser. Numbers that live in client-safe modules
 * are imported (ridership-model, the protocol) so they cannot drift; numbers
 * that live in server-only or private code are written out here and pinned by
 * project-knowledge.test.ts, which fails if the code changes underneath them.
 *
 * Writing style: third person ("the assistant can…"), because the same text
 * is read by the map assistant AND shown by the docs chat.
 *
 * 📖 Learn: "tiered context" — a short always-on core keeps every request
 * cheap, while long methodology text is retrieved only when a question needs
 * it. It is retrieval-augmented generation (RAG) without a vector database:
 * the "retriever" is the model choosing a topic id.
 */

import { HISTORY_LIMITS, MAP_LAYER_IDS, type MapLayerId } from "./map-assistant-protocol";
import { MODE_COSTS, OPERATING_COST_M_PER_KM_YEAR } from "./cost-model";
import {
  DEFAULT_HEADWAY_MIN,
  DEFAULT_MODE_FACTOR,
  DEFAULT_WALK_RADIUS_KM,
  MODE_FACTORS,
} from "./ridership-model";

// ── Numbers the text quotes ───────────────────────────────────────────────────

/**
 * Numbers the text quotes whose source of truth is server-only or private code
 * (so this client-safe module can't import them; client-safe ones such as the
 * ridership model's MODE_FACTORS are imported directly instead). project-knowledge.test.ts
 * compares every value with the real code and fails when one drifts — that is
 * the alarm that says "update the docs too".
 */
export const QUOTED_CONSTANTS = {
  /** lib/cost-model.ts MODE_COSTS[mode].perKmBn (client-safe, so read directly; can't drift) */
  costPerKmBn: {
    subway: MODE_COSTS.subway.perKmBn,
    lrt: MODE_COSTS.lrt.perKmBn,
    streetcar: MODE_COSTS.streetcar.perKmBn,
    bus: MODE_COSTS.bus.perKmBn,
  },
  /** lib/cost-model.ts MODE_COSTS[mode].perStationBn */
  costPerStationBn: {
    subway: MODE_COSTS.subway.perStationBn,
    lrt: MODE_COSTS.lrt.perStationBn,
    streetcar: MODE_COSTS.streetcar.perStationBn,
    bus: MODE_COSTS.bus.perStationBn,
  },
  /** gaps.ts DEFAULT_GAP_THRESHOLD_KM / POCKET_RADIUS_KM / MIN_AREA_POPULATION / MAX_AREAS */
  gapThresholdKm: 1.0,
  gapPocketRadiusKm: 2.5,
  gapMinPopulation: 2000,
  gapMaxAreas: 12,
  /** census.ts populationServedByNetwork(network, walkKm = 0.8) — the coverage measure */
  coverageWalkKm: 0.8,
  /** TransitMap.tsx stationPopulations cutoff: streetcar/bus 0.5 km, everything else 0.8 km */
  stationPopRadiusKm: { rapid: 0.8, surface: 0.5 },
  /** simulation.ts ACCESS_WALK_M / WALK_TRANSFER_M / SPEED; api/simulation seed default */
  simAccessWalkM: 800,
  simTransferWalkM: 400,
  simSeed: 42,
  simSpeedsKmh: { subway: 35, lrt: 25, streetcar: 15, bus: 20, go_train: 60 },
  /** council-graph.ts MAX_REVISIONS and the sim node's agentCount */
  councilMaxRevisions: 2,
  councilSimAgents: 150,
  /** AIAnnotationsContext.tsx TTL_MS */
  aiFindingsTtlHours: 24,
  /** useLiveVehicles.ts polling interval */
  liveVehiclePollSeconds: 15,
  /** TransitMap.tsx catchmentRadius / disruptionRadius defaults */
  catchmentDefaultM: 800,
  disruptionDefaultM: 200,
  /** useTransitDesert.ts MODE_WEIGHT */
  desertModeWeights: { subway: 1.0, lrt: 1.0, go_train: 0.9, streetcar: 0.9, bus: 0.85 },
} as const;

const Q = QUOTED_CONSTANTS; // short alias for the template strings below

function km(n: number): string {
  return `${n} km`;
}

function money(bn: number): string {
  return bn >= 1 ? `$${bn}B` : `$${Math.round(bn * 1000)}M`;
}

// ── Overlay catalogue ─────────────────────────────────────────────────────────

export interface OverlayInfo {
  /** The name exactly as the user sees it (Layers menu label where there is one). */
  label: string;
  /** The grey sub-line under the label in the Layers menu ("" when not listed there). */
  subtitle: string;
  whatItShows: string;
  colours: string;
  howToToggle: string;
  /** Where the on-screen wording or behaviour is misleading. Stated truthfully. */
  caveats?: string;
}

/**
 * Every overlay the UI snapshot can report (MAP_LAYER_IDS in the protocol).
 * Typed as a Record over MapLayerId, so adding an id to the protocol without a
 * catalogue entry is a compile error — the assistant can never be asked about
 * a layer it has no words for.
 */
export const OVERLAY_CATALOG: Record<MapLayerId, OverlayInfo> = {
  population: {
    label: "Population Density",
    subtitle: "Residents per km²",
    whatItShows:
      "where people LIVE — 2021 census residents per km² for each census block, log-scaled; it says nothing about transit",
    colours: "green → yellow → orange → red = low → high density; fades as you zoom in, replaced by block dots from about zoom 15",
    howToToggle: "Layers → Population Density (pinned under Layers by default)",
  },
  canadaPop: {
    label: "Canada pop density",
    subtitle: "Country-wide population heatmap",
    whatItShows: "the same idea for all of Canada (a 2020 1 km density grid), for zoomed-out views; gone by about zoom 14",
    colours: "green → yellow → orange → red = sparse → dense",
    howToToggle: "Layers → Canada pop density",
  },
  serviceHeatmap: {
    label: "Service Heatmap",
    subtitle: "Density weighted by mode",
    whatItShows:
      "where transit SUPPLY is concentrated — the density of the plan's stops, weighted subway/LRT 3, streetcar 2, other 1; no population, ridership or frequency",
    colours: "green → amber → orange → red = few → many weighted stops",
    howToToggle: "Layers → Service Heatmap",
    caveats: "plan lines only (hidden ones included); unloaded bus routes are ignored",
  },
  transitDesert: {
    label: "Transit deserts",
    subtitle: "Underserved population areas",
    whatItShows:
      "where many people live far from good transit — population density × (1 − access); access drops with distance to the nearest stop and rises with frequency, mode and the number of lines within 800 m; recomputes as lines change",
    colours: "pale yellow → orange → red → dark red = mild → severe",
    howToToggle: "Layers → Transit deserts (spinner while it computes)",
    caveats:
      "always counts the built-in subway/LRT/streetcar lines (even after Empty map or hiding them) but only loaded bus routes; lines without a timetable (drawn lines, streetcars) count as every 30 min",
  },
  traffic: {
    label: "Traffic",
    subtitle: "Current Mapbox traffic",
    whatItShows: "roads coloured by a STORED average-traffic table — not live traffic",
    colours: "green / amber / red road lines = light → heavy average traffic",
    howToToggle: "Layers → Traffic (pinned by default)",
    caveats: "its subtitle wrongly says \"Current Mapbox traffic\"",
  },
  coverage: {
    label: "Coverage Zones",
    subtitle: "500 m radius per stop",
    whatItShows: "a faint circle around every stop in the plan, for eyeballing walking coverage",
    colours: "translucent sky-blue circles",
    howToToggle: "Layers → Coverage Zones",
    caveats:
      "labelled \"500 m radius per stop\" but drawn in screen pixels, so the true radius changes with zoom (about 200–250 m at street zooms); for true distances use Catchment circles or the 800 m coverage measure",
  },
  catchment: {
    label: "Catchment circles",
    subtitle: "Radius around each station (advanced config in Analysis panel)",
    whatItShows: `true-to-scale walk-shed rings around the stations of visible lines (default ${QUOTED_CONSTANTS.catchmentDefaultM} m)`,
    colours: "faint green rings",
    howToToggle: "Layers → Catchment circles; radius (100–3000 m) in Analysis panel → Catchment Zones",
  },
  disruption: {
    label: "Disruption zones",
    subtitle: "Noise/impact buffer (advanced config in Analysis panel)",
    whatItShows: `impact buffers (default ${QUOTED_CONSTANTS.disruptionDefaultM} m) around one chosen line or all visible lines, e.g. construction noise`,
    colours: "light red fill, dashed red outline",
    howToToggle: "Layers → Disruption zones; line and radius in Analysis panel → Disruption Zones",
  },
  isochrone: {
    label: "Isochrone (travel time)",
    subtitle: "\"<minutes> min <mode>\", or \"Pick origin to start\"",
    whatItShows:
      "the area reachable from one origin within 15/30/45/60 minutes by walking, cycling or driving (Mapbox Isochrone API; transit is not modelled)",
    colours: "nested bands: 15 min green, 30 amber, 45 red, 60 purple (up to the chosen maximum)",
    howToToggle: "Layers → Isochrone (travel time) → pick an origin, Max travel time and mode; toggle it off to clear",
  },
  liveVehicles: {
    label: "Live vehicles",
    subtitle: "Real-time TTC positions",
    whatItShows: `real-time TTC vehicle positions (GTFS-Realtime), refreshed every ${QUOTED_CONSTANTS.liveVehiclePollSeconds} seconds`,
    colours: "red dots; click one for its route",
    howToToggle: "Layers → Live vehicles",
  },
  stationLabels: {
    label: "Station labels",
    subtitle: "Show stop names on each line",
    whatItShows: "the name of every stop next to it",
    colours: "plain text",
    howToToggle: "Layers → Station labels",
  },
  aiFindings: {
    label: "AI findings",
    subtitle: "\"<n> annotations from chat\", or \"Ask AI to draw on the map\"",
    whatItShows: `the assistant's own shading, pins and road-snapped corridors, kept for ${QUOTED_CONSTANTS.aiFindingsTtlHours} hours in this browser`,
    colours: "per finding: amber/red = gaps or warnings, sky-blue = info or well served; corridors in their mode's colour",
    howToToggle: "Layers → AI findings hides/shows them; \"Clear all\" next to the map-findings count in the chat deletes them",
  },
  customOverlay: {
    label: "Custom overlay",
    subtitle: "",
    whatItShows: "a KML, KMZ or Shapefile the user loaded",
    colours: "orange shapes",
    howToToggle: "Layers → Tools → Load custom overlay… (click the row again to remove it)",
  },
  simStress: {
    label: "Simulation stress",
    subtitle: "",
    whatItShows:
      "after a Simulate run, how heavily simulated commuters use each line segment relative to the busiest one (line width = load); proposed lines are dashed",
    colours:
      "existing lines by CHANGE: green = relieved by the proposal (> 8 points), red = busier (> 8 points), amber = little change; dashed new lines by load: green < 33%, amber, red > 66%",
    howToToggle: "appears after Simulate → Run; closing the Simulate panel clears it",
  },
  simAgents: {
    label: "Simulation agents",
    subtitle: "",
    whatItShows: "animated simulated commuters moving along their routes",
    colours: "orange = low, violet = mid, cyan = high income (incomes are synthetic)",
    howToToggle: "Simulate → \"Animate agents on map\"; Stop / Replay in the bottom bar",
    caveats: "the bar's legend shows mid income as teal, but those dots are violet",
  },
};

/** One catalogue entry as a single prompt line (used by the core tier and the UI snapshot). */
export function describeOverlay(id: MapLayerId, opts: { includeHowTo?: boolean } = {}): string {
  const o = OVERLAY_CATALOG[id];
  const parts = [`${o.label} [${id}] — ${o.whatItShows}. Colours: ${o.colours}.`];
  if (opts.includeHowTo) parts.push(`Toggle: ${o.howToToggle}.`);
  if (o.caveats) parts.push(`Caveat: ${o.caveats}.`);
  return parts.join(" ");
}

// ── Knowledge sections ────────────────────────────────────────────────────────

export type KnowledgeTier = "core" | "lookup";

export interface KnowledgeSection {
  id: string;
  title: string;
  tier: KnowledgeTier;
  body: string;
}

/**
 * Methodology topics the assistant can fetch with `lookup_app_docs`. A const
 * tuple (not a plain string[]) so it doubles as the tool's JSON-schema enum
 * and as a TypeScript union type.
 */
export const LOOKUP_TOPICS = [
  "coverage_and_gaps",
  "ridership_model",
  "route_score",
  "costs",
  "simulation",
  "council",
  "transit_desert",
  "population_data",
  "live_data",
  "privacy",
  "roadmap",
  "tech_stack",
] as const;
export type LookupTopic = (typeof LOOKUP_TOPICS)[number];

// CORE tier — always in the map assistant's prompt. Budget ≈ 3k tokens; the
// test enforces a ceiling so this can't silently bloat every request.

const CORE_APP = `Transit Planner is a free web app for sketching transit lines on a live map of Toronto and testing them against real data: the 2021 census, the TTC network, a commuter simulation and an AI planning council. The workspace is the /map page; written docs live at /docs. It is built for desktop browsers (phones get a reduced bottom menu). Terms of Service: AI outputs may be inaccurate, incomplete or biased.`;

const CORE_UI = `SCREEN LAYOUT: Lines panel top-left. Top-centre toolbar: Layers · Simulate · Plans · Ask AI (beta) · tools (Explore mode, Select neighbourhoods, Undo, Redo; Clear selection while something is selected). Top-right: Import and Export (amber dot on Export = unsaved changes; one Import / Export menu on narrow screens) and Settings ⚙. Bottom-right: Bird's eye view, zoom + / −. Bottom-centre: Generate Route / View Council (while neighbourhoods or stations are selected, or after a council run).
HOW TO:
- New line: Lines panel → New Line → Line name, Badge label (auto-filled), type (subway, streetcar or bus), Color → Create → click the map to drop stations (each is inserted where it fits best) → Done in the banner, or Enter. Bus and streetcar lines follow roads.
- Add stations to a line: Lines panel → click the line's badge or name (or the pencil "Edit line") → click the map → Done / Enter.
- Edit a station: click its dot → popup: click the name to rename, "Remove station" (or Backspace/Delete), "Add transfer to:".
- Line details: click a line ON THE MAP → Route panel: stops, Population Served, Frequency, route score grades, View timetable, Snap to roads, Add portal (tunnel entrance), Delete stop (stop selected), Delete line.
- Show/hide lines: Lines panel sections Subway / LRT, GO Train, Streetcars, Bus; hover a row → eye icon; the section-header eye toggles all; the caret collapses. The ~200 TTC bus routes start hidden: the eye only DRAWS a bus route — clicking its name or badge loads it into the plan (and starts add-station mode; press Done), and only then does it count in coverage, gaps, heatmaps and exports.
- Layers menu: "Map overlays" (click a row to toggle; "Pin to toolbar" adds a quick toggle under Layers — Population Density and Traffic are pinned by default) and "Tools": Measure distance, Load custom overlay… (.kml/.kmz/.shp).
- Simulate: toolbar Simulate → agents (500–10,000), time window (6am–midnight) → "Run Baseline Simulation" (no custom lines) or "Run Scenario Comparison" → tabs Overview, Equity, Stress, Analysis → "Animate agents on map"; stressed segments offer "Ask AI about this segment". Closing the panel clears results.
- Save: Plans (needs sign-in) → "Save new plan" / Update "<name>", New (blank plan); click a saved plan to load; Rename / Delete. Plans button dot: indigo = saved plan loaded, amber = unsaved changes. Without signing in: Export or a share link.
- Export downloads transit-plan-gtfs.zip (GTFS, validated first). Import takes a GTFS .zip or a .json export → "Merge & import" (adds; same line id overwrites) or "Replace & import" (removes all current lines first).
- Share link and images: Analysis panel → Export Data → "Copy shareable link" (lines, hidden lines, map view), PNG, PDF, Schematic SVG, Routes/Stops CSV.
- Settings ⚙: Sign in/out; Dark mode, High contrast, Imperial units, Analysis panel, Ask AI (beta), GO Transit (beta; adds the 7 GO lines to the plan); AI provider (Claude or Gemini); Advanced → Randomize council speaking order; Reset project; What's new; Docs; Contact us; Give feedback.
- Reset: Settings ⚙ → Reset project → "Restore default network" (drops custom lines, restores the TTC routes) or "Empty map" (removes every route and station); offers "Export first"; cannot be undone.
- Analysis panel (Settings ⚙ → Analysis panel), 20 cards: Network Stats, City Coverage, Route Score, Network Issues, Compare Routes, Simulation (service by hour), Accessibility, Feasibility Doc, Rolling Stock, Station Design, Land Acquisition, Jump to Place, Cost Estimator, Network Gaps, Catchment Zones, Export Data, Elevation Profile, Disruption Zones, Ridership Forecast, AI Assistant — plus Game Mode ("Transit City Builder": a $B budget and public approval; goal 80% coverage by 2035).
- Planning council: Select neighbourhoods tool → click neighbourhoods and/or stations → Generate Route → AI agents debate; the winning route is added as a new custom line; View Council reopens the debate.
- Ask AI: toolbar button (if hidden: Settings ⚙ → Ask AI), right-click the map → "Ask AI about here", "Ask AI about this segment" in Simulate → Stress, or the Analysis panel's AI Assistant card.
- Keys: Ctrl/⌘+Z undo, Ctrl/⌘+Shift+Z redo, Enter finishes adding stations, Backspace/Delete removes the selected station, Esc closes menus.`;

function buildCoreLayers(): string {
  const lines = MAP_LAYER_IDS.map((id) => `- ${describeOverlay(id, { includeHowTo: true })}`);
  return `LAYERS & HEATMAPS (there is no on-map legend; the [id] is how the screen snapshot names a layer). Several heatmaps share a green→red ramp, so identify a heatmap from WHICH layer is on, never from its colours:\n${lines.join("\n")}`;
}

const CORE_DATA = `DATA SOURCES:
- Population: Statistics Canada 2021 Census, dissemination-block populations (stored in Supabase).
- Neighbourhoods: the City of Toronto's 158 official neighbourhoods (Open Data), plus the 6 former boroughs (Scarborough, North York, Etobicoke, East York, York, the old City of Toronto) for naming.
- Network: from TTC and Metrolinx GTFS — 16 built-in rapid-transit and streetcar lines (subway Lines 1, 2, 4; LRT Lines 5 Eglinton and 6 Finch West; streetcars 501 and 503–512), 208 TTC bus routes and 7 GO Transit lines. A new map starts with only the 16 built-in lines in the plan.
- Live: TTC GTFS-Realtime (vehicle positions; trip updates for live speeds). Traffic: a stored average-traffic table, not live.
- Services: Mapbox (base map, isochrones, road snapping), Google Street View (neighbourhood photos), ElevenLabs (reads council quotes aloud).`;

const CORE_ASSISTANT = `THE ASK AI ASSISTANT:
- Sees: the user's plan (every line loaded into it, hidden and custom lines included) and a snapshot of the screen (layers on, map view, selection, open panels, latest simulation).
- Measures (from the census and the current plan): coverage share, coverage gaps and best-served pockets, population and estimated ridership near a point, nearby stops and routes.
- Draws "AI findings": shaded areas, pins, road-snapped corridors, camera moves.
- Controls the view: switches layers on/off, draws an isochrone, focuses a line or neighbourhood, shows/hides lines, opens or closes the Simulate, Plans or Analysis panel.
- Runs the commuter simulation (baseline vs the user's custom lines) and explains it; the results open in the Simulate panel.
- Drafts a new line: a preview plus a confirm card — nothing is added until the user clicks "Add to map".
- Opens the Reset dialog (only the user can confirm it).
- Cannot: edit or delete existing lines or stations, save or load plans, import/export, sign in, change settings (dark mode, units, AI provider), start the planning council, or see bus routes that are not loaded into the plan.
- Chats are saved in this browser only (clearing site data deletes them); "New chat" starts over; the assistant remembers up to the last ${HISTORY_LIMITS.maxUserTurns} questions of a conversation.`;

const CORE_KNOWN_ISSUES = `KNOWN ISSUES (describe them truthfully if asked):
- Bus routes count only once loaded into the plan (see Show/hide lines). The assistant's measures, Service Heatmap, Coverage Zones and exports use the plan only; Transit deserts uses the built-in rapid-transit/streetcar lines plus the plan.
- The Traffic layer's subtitle says "Current Mapbox traffic", but it is a stored average-traffic table.
- Coverage Zones are labelled 500 m but drawn in screen pixels, so their true radius changes with zoom.
- The simulation baseline is always the built-in TTC network including every bus route, whatever the user edited; only custom lines (ones drawn with New Line or added by the council) are tested.
- The Simulate panel describes the equity score as "time savings weighted…", but it is a weighted share of agents with a workable transit commute.
- The Boundary drawing tool is hidden for now, although older docs mention it.`;

const CORE_FAQ = `FAQ:
- "What is this heatmap / layer?" → check which layers the screen snapshot says are ON and explain that one (what it shows, colours, caveats). If several heatmaps are on, name each. If the snapshot is unknown, list the candidates.
- "Why don't the numbers match?" → different radii (Coverage Zones ≈ pixels, Population Served ${Q.stationPopRadiusKm.surface}/${Q.stationPopRadiusKm.rapid} km, coverage share ${km(Q.coverageWalkKm)}, gaps > ${km(Q.gapThresholdKm)}), and bus routes not loaded into the plan.
- "How do I save?" → Plans (sign-in), otherwise Export (GTFS .zip) or the shareable link.
- "Where are my chats?" → in this browser only.
- "Is this real data?" → census, network, neighbourhoods and live vehicles are real; traffic is a stored average; simulation commuters and their incomes are synthetic; ridership figures are illustrative estimates.
- "Can you add / build a line for me?" → the assistant can draft one with a confirm card; the user clicks "Add to map". Manual route: New Line.`;

const CORE_SECTIONS: KnowledgeSection[] = [
  { id: "app", title: "What the app is", tier: "core", body: CORE_APP },
  { id: "ui", title: "Screen layout and how-tos", tier: "core", body: CORE_UI },
  { id: "layers", title: "Layers and heatmaps", tier: "core", body: buildCoreLayers() },
  { id: "data", title: "Data sources", tier: "core", body: CORE_DATA },
  { id: "assistant", title: "The Ask AI assistant", tier: "core", body: CORE_ASSISTANT },
  { id: "known_issues", title: "Known issues", tier: "core", body: CORE_KNOWN_ISSUES },
  { id: "faq", title: "FAQ", tier: "core", body: CORE_FAQ },
];

// LOOKUP tier — fetched on demand. A Record over LookupTopic, so a topic id
// without a section is a compile error.

const modeFactorList = Object.entries(MODE_FACTORS)
  .map(([mode, factor]) => `${mode === "go_train" ? "GO" : mode} ${factor}`)
  .join(", ");

const LOOKUP_SECTIONS: Record<LookupTopic, { title: string; body: string }> = {
  coverage_and_gaps: {
    title: "Coverage and gaps",
    body: `- Coverage share (the assistant's coverage measure): census population living within ${km(Q.coverageWalkKm)} (straight line) of ANY stop in the plan ÷ Toronto's census population. Each census block counts once, however many stops are near it.
- Coverage gaps (the assistant's gap ranking): census blocks farther than ${km(Q.gapThresholdKm)} from every stop are "unserved". They are grouped into pockets of up to ${km(Q.gapPocketRadiusKm)} around the worst block; pockets under ${Q.gapMinPopulation.toLocaleString("en-CA")} people are skipped; at most ${Q.gapMaxAreas} are returned, worst first, named by neighbourhood (and former borough). "Best served" is the mirror image: pockets of blocks within the threshold, ranked by people × closeness.
- Route panel "Population Served": census population within ${km(Q.stationPopRadiusKm.rapid)} of each subway/LRT/GO station or ${km(Q.stationPopRadiusKm.surface)} of each streetcar/bus stop, summed per station (a block near two stations counts twice).
- Coverage Zones layer: pixel circles (not true distances). Catchment circles: true-to-scale rings (default ${Q.catchmentDefaultM} m).
- Analysis → City Coverage / Network Gaps: which named population centres have a stop inside their service radius — a coarser, town-level check.
- All of these use only the lines loaded into the plan (unloaded bus routes are invisible to them), which is the usual reason two coverage numbers disagree.`,
  },
  ridership_model: {
    title: "Ridership model",
    body: `A gravity model, shared by the Analysis panel's Ridership Forecast and the assistant's ridership estimate:
- daily boardings = catchment population × max(0.1, 60 ÷ headway in minutes) × mode factor ÷ 365.
- Mode factors: ${modeFactorList}; any other mode ${DEFAULT_MODE_FACTOR}.
- The assistant's single-stop estimate defaults to a ${km(DEFAULT_WALK_RADIUS_KM)} walk radius and a ${DEFAULT_HEADWAY_MIN}-minute headway.
- The Ridership Forecast card sums each station's walk-shed population (${km(Q.stationPopRadiusKm.rapid)} rapid transit, ${km(Q.stationPopRadiusKm.surface)} streetcar/bus); it parses the headway from the line's frequency text (30 min if none) and falls back to 5,000 people per stop while census data is loading.
- It is illustrative only — not calibrated against TTC ridership counts, and it ignores destinations, competition between lines and fares.`,
  },
  route_score: {
    title: "Route score",
    body: `Shown in the Route panel and the Analysis panel's Route Score / Compare Routes cards:
- frequency = 100 − 2 × headway in minutes (headway parsed from the line's frequency text; 30 if missing)
- coverage = 3 × number of stops (max 100)
- connectivity = % of the line's stops within 0.5 km of another line's stop
- efficiency = straight-line distance ÷ path length × 150 (max 100)
- overall = average of the four, graded A ≥ 90, B ≥ 75, C ≥ 60, D ≥ 45, otherwise F.
With a stop selected, the Route panel grades the STATION instead: frequency, connectivity (33 points per transfer line) and demand (the station's population relative to the busiest station), averaged.
New lines drawn by hand have no timetable (frequency "—"), so their frequency part is low.`,
  },
  costs: {
    title: "Cost estimates",
    body: `One formula is used everywhere a cost appears (council scorecard and result card, Analysis → Feasibility Doc and Cost Estimator, the assistant's draft lines):
capital = km × per-km cost + stations × per-station cost. Subway ${money(Q.costPerKmBn.subway)}/km + ${money(Q.costPerStationBn.subway)}/station; LRT and streetcar ${money(Q.costPerKmBn.lrt)}/km + ${money(Q.costPerStationBn.lrt)}/station; bus ${money(Q.costPerKmBn.bus)}/km + ${money(Q.costPerStationBn.bus)}/station. GO lines use the LRT rates.
- Cost Estimator: the Underground % / Elevated % sliders re-weight only the track part, relative to the line's typical alignment (subways are priced as tunnelled, everything else as surface): track cost × (surface + 2 × elevated + 5 × tunnel share) ÷ the typical alignment's factor. The sliders start at the typical alignment, so the estimator opens on the same number as every other panel.
- Operating cost: about $${OPERATING_COST_M_PER_KM_YEAR}M per km per year.
- The council result card's other figures are rules of thumb, not model outputs: build years = km × 1.2 + 3 (subway), × 0.6 + 2 (LRT/streetcar), × 0.1 + 1 (bus), rounded up; minutes saved = km × 3.5 (subway) or × 2; dollars saved = minutes × $0.30 per trip; approval chance = 85 − 1.5 × the PR critic's raw score (0–40), kept between 15% and 92%.
- Separate from the formula: Station Design shows fixed per-station ranges by style ($180–320M underground, $90–150M elevated, $40–80M surface), and Game Mode uses fixed project prices.
Example: a 10 km, 10-station subway costs $6.5B.`,
  },
  simulation: {
    title: "Commuter simulation (Simulate)",
    body: `- Agents: 500–10,000 in the panel (the assistant runs 100–1,000; default 500), fixed random seed ${Q.simSeed}, so reruns match. Homes are sampled in proportion to census population (from the most populous census blocks); each agent gets a persona (worker, student, senior, shift worker, parent) and a day of trips (commute plus errands).
- Incomes are SYNTHETIC — inferred from distance to downtown — and drive the equity weights and dot colours.
- Routing: shortest time over a graph of the built-in subway/LRT/streetcar lines and ALL 208 bus routes (the baseline), plus the user's custom lines for the scenario. Walk at most ${Q.simAccessWalkM} m to a stop and ${Q.simTransferWalkM} m between stops to transfer; walking 5 km/h. Typical speeds: subway ${Q.simSpeedsKmh.subway}, LRT ${Q.simSpeedsKmh.lrt}, streetcar ${Q.simSpeedsKmh.streetcar}, bus ${Q.simSpeedsKmh.bus}, GO ${Q.simSpeedsKmh.go_train} km/h, plus a boarding wait per mode. The panel's own Run fetches live TTC speeds first and uses them when under 10 minutes old; the assistant's run uses the typical speeds. Peak periods (7:00–9:30 and 16:30–19:00) slow driving to model congestion.
- Outputs: % of agents whose commute is workable by transit, average/median/90th-percentile transit minutes, average transfers, time saved per rider (baseline − scenario average), "newly accessible" (trips in the time window that become possible by transit — the panel calls them agents), an equity score, and segment stress (each segment's load relative to the busiest segment).
- Equity score: the share of agents with a workable transit commute, weighted by income (low 1.5, mid 1.0, high 0.5) and transit dependence; agents with no transit option count at full dependence. The panel's text "time savings weighted…" is inaccurate.
- The time window only filters which trips are listed and animated; the headline stats cover the whole day.
- The Analysis tab (proposals only) is a short AI-written summary.`,
  },
  council: {
    title: "AI planning council",
    body: `- Start: Select neighbourhoods tool → click neighbourhoods and/or stations → Generate Route. View Council reopens it; past runs are kept in this browser and "Full report" exports HTML.
- A LangGraph state machine: Alex Chen (Ridership Planner) and Jordan Park (Infrastructure Analyst) on Claude Sonnet 4.6 each propose a route using the same grounded tools as the assistant (census population, ridership, gap ranking) → a ${Q.councilSimAgents}-agent commuter simulation scores both → Margaret Thompson (Neighbourhood Rep) and Devon Walsh (PR Director) on Claude Haiku 4.5 critique and vote on stops → if both critics contest 2 or more stops the planners revise (at most ${Q.councilMaxRevisions} revision rounds) → the Planning Commission (Sonnet 4.6) gives the verdict. Speaking order is randomised by default (Settings ⚙ → Advanced → Randomize council speaking order).
- Rules: subway only; new stops at least 800 m from existing and other proposed stations unless they are transfers; no gap over 1,500 m between consecutive stops.
- The winning route is added automatically as a new custom line. Its card's Cost uses the shared cost formula; Timeline, Minutes Saved, Dollars Saved, Approval Chance and PR Nightmare Score are rules of thumb (topic "costs").
- After a run, neighbourhood selection stays locked until the page is reloaded.`,
  },
  transit_desert: {
    title: "Transit deserts layer",
    body: `For every census block:
- density = log(1 + people per km²) ÷ the largest value (0–1), the same scaling as Population Density.
- nearest stop distance d (km); headway h of that stop's line (lines without a timetable — every drawn line and the built-in streetcars — count as 30 min); mode weight w: subway/LRT ${Q.desertModeWeights.subway.toFixed(1)}, GO ${Q.desertModeWeights.go_train}, streetcar ${Q.desertModeWeights.streetcar}, bus ${Q.desertModeWeights.bus}.
- frequency score = min(1, 30 ÷ h); distance penalty = 1 + d ÷ 0.4; connectivity bonus = min(1.5, 1 + 0.1 × (lines within 800 m − 1)).
- access = min(1, frequency × w × bonus ÷ distance penalty); severity = density × (1 − access).
Stops considered: the built-in subway/LRT/streetcar lines (always, even after Empty map or hiding) plus every line in the plan. Unloaded bus routes are ignored, so suburbs served only by buses can look worse than they are.`,
  },
  population_data: {
    title: "Population and census data",
    body: `- Source: Statistics Canada, 2021 Census Geographic Attribute File (92-151-X): dissemination-block population and land area, each placed at a representative point, stored in Supabase.
- The repository's upload script clips to roughly latitude 43.60–43.85 and longitude −79.60 to −79.10; if the live table was built with it, the city's far-west and south-west lakeshore edges may be thin.
- Population Density colours log(1 + people per km²), normalised to the densest block.
- The assistant measures from a cached Toronto slice of the same table (refreshed hourly); if it can't load, the assistant says so rather than guessing.
- Canada pop density is a separate 2020 1 km UN-adjusted density grid, served as map tiles.
- Neighbourhood names come from the City of Toronto's 158 neighbourhoods; the neighbourhood panel shows a Street View photo, total population and traffic level.`,
  },
  live_data: {
    title: "Live data",
    body: `- Live vehicles: TTC GTFS-Realtime vehicle positions, polled every ${Q.liveVehiclePollSeconds} seconds while the layer is on.
- Live speeds: TTC GTFS-Realtime trip updates are turned into per-mode speeds and waits (cached 5 minutes). The Simulate panel fetches them before each run and uses them only if under 10 minutes old; otherwise it uses typical speeds.
- NOT live: the Traffic layer (stored average), the census (2021), the network shapes (GTFS snapshot) and ridership (a model).`,
  },
  privacy: {
    title: "Privacy",
    body: `- Ask AI chats are stored in this browser's local storage; each new message sends the conversation so far, plus the plan and screen snapshot, to the app's server, which forwards it to the AI provider chosen in Settings ⚙ → AI provider (Anthropic or Google Gemini). The server does not keep the conversation.
- If the operator enabled tracing, AI turns (messages, tool calls, results) are recorded in Langfuse; if Discord webhooks are configured, the first 200 characters of a chat message are posted to the operator's Discord.
- AI findings are kept ${Q.aiFindingsTtlHours} hours in this browser. Council runs are kept in this browser.
- Plans are stored in Supabase for signed-in users (sign-in via Auth0). Product analytics may use Mixpanel; opening the app with ?m in the URL (or setting skip_tracking in local storage) opts this browser out of analytics and visit reporting — not out of AI traffic.
- Full policy: /privacy.`,
  },
  roadmap: {
    title: "Roadmap and changelog",
    body: `- In the works (About page): accessibility-analysis inputs (street network, zones, destinations, demographics); r5 routing-engine integration with open-source accessibility/equity libraries; an interactive dashboard for travel times, accessibility and equity indicators; broader exports (maps, datasets, summary reports — GTFS export and validation exist today).
- Planned: a more truly agentic commuter simulation (individual schedules and mode choice) and greenhouse-gas estimates for network changes.
- Latest changelog entry (Settings ⚙ → What's new): v0.6 (May 2026) — LangGraph council, cycling through past council outputs, simulation variables, equity metrics and a dynamic time window. Ask AI, Plans, Reset/Empty map and AI findings arrived after v0.6 and are not in the changelog yet.`,
  },
  tech_stack: {
    title: "Tech stack",
    body: `- Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS 4; Mapbox GL (+ Mapbox GL Draw); Three.js for the landing-page globe.
- Supabase (Postgres + PostGIS) for census, traffic and saved plans; Auth0 sign-in.
- AI: Anthropic Claude (Ask AI uses a Haiku model; the council uses Sonnet 4.6 and Haiku 4.5) or Google Gemini; the council runs on LangGraph; Langfuse tracing; ElevenLabs voice.
- Ask AI is stateless on the server: the browser keeps the chat and sends it with each message; read tools run on the server against the census and the user's plan; drawings and app actions are validated on the server and carried out in the browser.
- Tests: Vitest. Hosting: Vercel.
- Source layout: web/src/app (pages, API routes, map UI), web/src/server (AI providers, tools, simulation, council), web/src/lib (shared logic).`,
  },
};

export const KNOWLEDGE_SECTIONS: readonly KnowledgeSection[] = [
  ...CORE_SECTIONS,
  ...LOOKUP_TOPICS.map((topic) => ({
    id: topic,
    title: LOOKUP_SECTIONS[topic].title,
    tier: "lookup" as const,
    body: LOOKUP_SECTIONS[topic].body,
  })),
];

// ── Builders ──────────────────────────────────────────────────────────────────

/**
 * The always-on tier, as one string. Deterministic (no dates, no counts from
 * the request), so it can sit inside a cached prompt prefix.
 */
export function buildCoreKnowledge(): string {
  return CORE_SECTIONS.map((s) => s.body).join("\n\n");
}

export function isLookupTopic(value: unknown): value is LookupTopic {
  return typeof value === "string" && (LOOKUP_TOPICS as readonly string[]).includes(value);
}

/** One methodology topic, or a short "unknown topic" note listing the valid ids. */
export function lookupKnowledge(topic: string): string {
  if (!isLookupTopic(topic)) {
    return `Unknown topic "${topic}". Valid topics: ${LOOKUP_TOPICS.join(", ")}.`;
  }
  const section = LOOKUP_SECTIONS[topic];
  return `${section.title.toUpperCase()}\n${section.body}`;
}

/** Everything (core + every lookup topic) — the /docs chat's corpus. */
export function buildDocsCorpus(): string {
  const lookups = LOOKUP_TOPICS.map((topic) => lookupKnowledge(topic)).join("\n\n");
  return `=== THE APP (overview, how-tos, layers, known issues) ===\n\n${buildCoreKnowledge()}\n\n=== METHODOLOGY AND REFERENCE ===\n\n${lookups}`;
}
