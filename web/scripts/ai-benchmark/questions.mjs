// The benchmark question set for the "Ask AI" map assistant (POST /api/ai/chat
// with mapTools: true). Each item's `expectedOutput` is an INVARIANT to check
// against what actually happened, not literal text — the model's wording
// varies run to run, but "did it call rank_service_areas with order:
// best_served" does not.
//
// Items are stored in Langfuse as JSON (dataset.mjs), so everything here must
// be plain JSON: no RegExp objects, no undefined, no functions. Re-run
// dataset.mjs after editing this file — run.mjs reads the items from Langfuse.
//
// ── input ───────────────────────────────────────────────────────────────────
//   { message, networkRoutes?, ui? }                  a one-turn conversation
//   { turns: [{ message, networkRoutes?, ui? }, …] }  several turns; a turn
//       without networkRoutes / ui reuses the previous turn's (the browser
//       sends its live map state with every message). The server is stateless:
//       run.mjs carries the conversation forward as `history`.
//   - networkRoutes omitted or [] → the server's default network. A non-empty
//     array REPLACES that network entirely (it stands for the user's whole map).
//   - ui → a MapUiSnapshot (web/src/lib/map-assistant-protocol.ts): what the
//     user currently sees. Layers that aren't listed are off.
//
// ── expectedOutput: two different places a check can look (run.mjs) ────────
//   - `expectToolCalls` / `forbidToolCalls` / `expectToolCallCount` /
//     `expectArtifactConsistency`: matched against the `tool_call` SSE events
//     the browser actually receives, by CLIENT name — annotations
//     (highlight_area, draw_corridor, drop_pin, fly_to) and app actions
//     (reset_network, set_map_layers, show_isochrone, focus,
//     set_route_visibility, open_panel, show_simulation, propose_line). Two
//     server tools are renamed on the way: show_area → highlight_area and
//     run_simulation → show_simulation. A tool_call only appears when the
//     server actually rendered / opened it — a rejected write never does.
//     These look at the LAST turn (expectArtifactConsistency compares turns).
//   - `expectTrace` / `forbidTrace`: matched against the Langfuse trace of the
//     last turn — root observation "map-assistant", tagged with
//     metadata.benchmarkRunId (see ToolContext.benchmarkRunId in
//     web/src/server/map-data/tools.ts) — by SERVER tool name. This is the
//     ONLY way to see the arguments of READ tools (rank_service_areas,
//     query_population, estimate_ridership, query_network, describe_location,
//     network_coverage, lookup_app_docs): the stream only shows a `status`
//     progress line for them.
//
// Argument filters, usable on any of the expectations above:
//   - argsMatch: TOP-LEVEL keys must be equal (arrays compared item by item).
//   - argsContains: deep partial match — objects match on a subset of their
//     keys; arrays match when every listed item matches SOME actual item, in
//     any order. (Only the first 30 items of an array are kept — see
//     compactForLog in conversation.mjs.)
//
// textChecks, on the final answer of the last turn (what is left after any
// text_reset): forbidQuestionMark, forbidNarration, maxSentences, and
// mustMatch / mustNotMatch: [{ pattern, flags }] — regexes written as strings,
// because JSON (and so Langfuse) can't store a RegExp. Remember to double the
// backslashes inside a JS string: "\\d" is the regex \d.
//
// 📖 Learn: this is why the runner needs both the SSE parser AND a Langfuse
// trace lookup per item — the client stream alone is blind to what the READ
// tools were asked.

/** A real, inhabited residential point (Yonge & Eglinton area). */
const INHABITED_POINT = [-79.4025, 43.7053];

/** A point well out in Lake Ontario — no census population, must be rejected. */
const LAKE_POINT = [-79.38, 43.6];

// ── Realistic "what the user sees" snapshots (MapUiSnapshot, v: 1) ──────────
// Shaped like what TransitMap reports. Each viewport's bounds are what
// map.getBounds() gives for a ~1440×800 px map at that centre and zoom
// (camera tilt ignored), and neighbourhoodAtCenter is the real City of Toronto
// neighbourhood containing the centre (checked against
// public/Neighbourhoods - 4326.geojson).

/** The view the app opens with (TransitMap's TORONTO centre, zoom 11.5). */
const VIEW_APP_DEFAULT = {
  center: [-79.3832, 43.6532],
  zoom: 11.5,
  bounds: [-79.558, 43.5829, -79.2084, 43.7234],
  neighbourhoodAtCenter: "Yonge-Bay Corridor",
};

/** Zoomed out over the whole city — how you'd look at a city-wide heatmap. */
const VIEW_CITY_WIDE = {
  center: [-79.3832, 43.7001],
  zoom: 10.8,
  bounds: [-79.6671, 43.5859, -79.0993, 43.814],
  neighbourhoodAtCenter: "Mount Pleasant East",
};

/** Central Scarborough, where the transit-desert layer has the most to show. */
const VIEW_SCARBOROUGH = {
  center: [-79.255, 43.7615],
  zoom: 12.2,
  bounds: [-79.3626, 43.7183, -79.1474, 43.8047],
  neighbourhoodAtCenter: "Bendale-Glen Andrew",
};

/** Pape → Don Mills & Eglinton, around the user-drawn line below. */
const VIEW_DON_MILLS_CORRIDOR = {
  center: [-79.3445, 43.7002],
  zoom: 12.8,
  bounds: [-79.4155, 43.6717, -79.2735, 43.7287],
  neighbourhoodAtCenter: "Thorncliffe Park",
};

/** Eglinton Avenue East between Don Mills and Kennedy. */
const VIEW_EGLINTON_EAST = {
  center: [-79.3017, 43.7262],
  zoom: 12.6,
  bounds: [-79.3832, 43.6935, -79.2202, 43.7589],
  neighbourhoodAtCenter: "Wexford/Maryvale",
};

/**
 * A first visit: default view, no overlays on, nothing selected or open,
 * default network, signed out. Items copy it and change only what their
 * question depends on, e.g. { ...BASE_UI, layers: [...] }.
 * 📖 Learn: object spread — `{ ...BASE_UI, layers: x }` copies every key of
 * BASE_UI, then replaces `layers`; BASE_UI itself is never modified.
 */
const BASE_UI = {
  v: 1,
  viewport: VIEW_APP_DEFAULT,
  layers: [],
  selection: { routeId: null, routeName: null, stopName: null, neighbourhood: null, selectedNeighbourhoods: [] },
  panels: { simulation: false, plans: false, analysis: false, routePanel: false, council: "closed" },
  network: {
    hiddenRouteIds: [],
    customLines: [],
    busRoutesLoaded: 0,
    goTransit: false,
    planName: null,
    unsavedChanges: false,
  },
  simulation: null,
  prefs: { dark: false, imperial: false },
  signedIn: false,
};

/**
 * A line the user drew themselves, in the shape the browser sends as
 * networkRoutes (the server only reads id, name, type and stops). The
 * "custom-" id prefix is what marks a line as a proposal for the simulation.
 * Pape and Don Valley use the exact station coordinates from
 * web/src/app/map/transit-data.ts; Cosburn (Pape Ave & Cosburn Ave) and
 * Thorncliffe Park (Overlea Blvd) are the real intersections.
 */
const RELIEF_LINE_NORTH = {
  id: "custom-1",
  name: "Relief Line North",
  type: "subway",
  stops: [
    { name: "Pape", coords: [-79.3449, 43.6798] },
    { name: "Cosburn", coords: [-79.3487, 43.6893] },
    { name: "Thorncliffe Park", coords: [-79.3446, 43.7049] },
    { name: "Don Valley", coords: [-79.338946, 43.719956] },
  ],
};

/**
 * "The draft was already added" claims, for action-draft-line's mustNotMatch.
 *
 * Why not one broad /\b(added|created)\b.*\bline\b/i: the HONEST reply to a
 * draft usually echoes the confirm card — "Nothing has been added yet — click
 * Add line to keep it" — and that sentence contains "added … line", so the
 * broad pattern would fail the very answer we want. These three patterns only
 * catch the claim being made: ['’] accepts both the straight and the curly
 * apostrophe, which models often write.
 */
const CLAIMS_LINE_WAS_ADDED = [
  // First person, done: "I added…", "I've added…", "I have just created…".
  { pattern: "\\bI(?:['’]ve| have)?(?: just)? (?:added|created)\\b", flags: "i" },
  // The line/it as the subject of a finished action: "the line has been
  // added", "it was created", "it's been added". ("Nothing has been added"
  // has a different subject, so it doesn't match.)
  { pattern: "\\b(?:line|it)(?: has been| was| is now|['’]s been) (?:added|created)\\b", flags: "i" },
  // A sentence that opens with the verb: "Created the Eglinton East line…".
  { pattern: "(?:^|[.!?]\\s+)(?:added|created)\\b", flags: "i" },
];

export const BENCHMARK_ITEMS = [
  // ── tool-selection ──────────────────────────────────────────────────────
  // The system prompt explicitly warns against this mix-up ("Answer the
  // direction that was ASKED — do not report gaps when asked about
  // well-served areas"), which means it was a real, observed failure mode.
  {
    id: "tool-selection-best-served",
    metadata: { category: "tool-selection" },
    input: { message: "Where is the network best served right now?", networkRoutes: [] },
    expectedOutput: {
      expectTrace: [{ tool: "rank_service_areas", argsMatch: { order: "best_served" } }],
      forbidTrace: [{ tool: "rank_service_areas", argsMatch: { order: "least_served" } }],
    },
  },
  {
    id: "tool-selection-least-served",
    metadata: { category: "tool-selection" },
    input: { message: "What's the biggest coverage gap on the east side of the city?", networkRoutes: [] },
    expectedOutput: {
      expectTrace: [{ tool: "rank_service_areas", argsMatch: { order: "least_served" } }],
      forbidTrace: [{ tool: "rank_service_areas", argsMatch: { order: "best_served" } }],
    },
  },

  // ── grounding ────────────────────────────────────────────────────────────
  // These are answerable ONLY by calling a tool — no shortcut lets the model
  // guess correctly, so "the tool was called at all" IS the grounding check.
  {
    id: "grounding-coverage-share",
    metadata: { category: "grounding" },
    input: { message: "What share of Toronto currently lives within walking distance of a stop?", networkRoutes: [] },
    expectedOutput: {
      expectTrace: [{ tool: "network_coverage" }],
    },
  },
  {
    id: "grounding-ridership-estimate",
    metadata: { category: "grounding", notes: "Coordinates are Yonge & Eglinton — a real inhabited point." },
    input: {
      message: `Estimate daily ridership for a new subway stop at [${INHABITED_POINT.join(", ")}].`,
      networkRoutes: [],
    },
    expectedOutput: {
      expectTrace: [{ tool: "estimate_ridership", argsMatch: { stop: INHABITED_POINT } }],
    },
  },

  // ── edge-case-rejection ──────────────────────────────────────────────────
  // Both ask for something the tools are specifically designed to refuse.
  // Checked on the CLIENT stream, not the trace: a rejected write never emits
  // a tool_call event at all (see resolveWriteTool in map-data/tools.ts), so
  // "this never appears" is the correct assertion, not "an error appears".
  {
    id: "edge-case-water-pin",
    metadata: { category: "edge-case-rejection", notes: `[${LAKE_POINT.join(", ")}] is well out in Lake Ontario.` },
    input: { message: `Put a pin at [${LAKE_POINT.join(", ")}] marking a potential stop.`, networkRoutes: [] },
    expectedOutput: {
      forbidToolCalls: [{ name: "drop_pin" }],
    },
  },
  {
    id: "edge-case-unknown-neighbourhood",
    metadata: { category: "edge-case-rejection", notes: "\"Zeta\" is not a real Toronto neighbourhood." },
    input: { message: "Shade the Zeta neighbourhood for me.", networkRoutes: [] },
    expectedOutput: {
      forbidToolCalls: [{ name: "highlight_area" }],
    },
  },

  // ── multi-turn artifact reuse ────────────────────────────────────────────
  // The system prompt's "anything you mention you MUST draw in the SAME
  // reply" rule means turn 1 ALREADY draws whatever area it names — a plain
  // "?" scope like "downtown" can also genuinely have zero qualifying gaps
  // (rank_service_areas legitimately returns areas: [] some days), which
  // isn't a bug, just data the item needs to be robust to. So rather than
  // asserting a SPECIFIC id (which depends on which real area gets ranked
  // #1, and on there being an area at all) or that turn 2 redraws (which the
  // model may reasonably skip since it already drew in turn 1), the
  // invariant is: whatever id turn 1 used, a later turn must never swap in a
  // DIFFERENT one when referring back to "it"/"that one".
  {
    id: "multi-turn-gap-reuse",
    metadata: { category: "multi-turn", notes: "Scarborough is large enough to reliably have a real gap, unlike dense downtown." },
    input: {
      turns: [
        { message: "What's the single worst-served part of Scarborough?", networkRoutes: [] },
        { message: "Now shade it on the map." },
      ],
    },
    expectedOutput: {
      expectArtifactConsistency: { tool: "highlight_area" },
    },
  },
  {
    id: "multi-turn-served-reuse",
    metadata: {
      category: "multi-turn",
      notes: "\"too\" reads as \"an additional, different one\" — reworded to unambiguously mean \"the same one again\".",
    },
    input: {
      turns: [
        { message: "Which neighbourhood is best served by the current network?", networkRoutes: [] },
        // Asks for the SAME area redrawn with a different severity — gives a
        // concrete reason to call highlight_area again (a bare "zoom in on
        // it" might not produce another highlight_area call at all, making
        // the consistency check vacuous rather than a real test).
        { message: "Mark it critical this time." },
      ],
    },
    expectedOutput: {
      // "Mark it critical" specifically demands a redraw, so (unlike the
      // gap-reuse item above) also assert that redraw actually happened.
      expectToolCalls: [{ name: "highlight_area", argsMatch: { severity: "critical" } }],
      expectArtifactConsistency: { tool: "highlight_area" },
    },
  },

  // ── output-discipline ────────────────────────────────────────────────────
  // The prompt says "Never end by asking a clarifying question — pick the
  // best answer and draw it" and "Call your tools, THEN write ONE final
  // caption of at most two short sentences."
  {
    id: "output-discipline-no-clarifying-question",
    metadata: { category: "output-discipline", notes: "Invites hedging; must commit to an answer instead of asking back." },
    input: { message: "What's roughly a good spot for a new stop somewhere? You pick.", networkRoutes: [] },
    expectedOutput: {
      textChecks: { forbidQuestionMark: true, maxSentences: 2, forbidNarration: true },
    },
  },
  {
    id: "output-discipline-draw-everything-mentioned",
    metadata: {
      category: "output-discipline",
      notes:
        "Two things are asked for; both must actually be drawn, not just described. " +
        "City-wide scope (not one district) so >=2 real gaps reliably exist regardless of network state.",
    },
    input: { message: "Show me the two biggest coverage gaps in Toronto.", networkRoutes: [] },
    expectedOutput: {
      expectTrace: [{ tool: "rank_service_areas", argsMatch: { order: "least_served" } }],
      expectToolCallCount: { name: "highlight_area", min: 2 },
      textChecks: { maxSentences: 2, forbidNarration: true },
    },
  },

  // ── app-actions ──────────────────────────────────────────────────────────
  // Not a map question at all — the model must route it to reset_network
  // (which only opens the confirm dialog) instead of drawing something or
  // claiming the wipe already happened.
  {
    id: "app-action-reset-wipe",
    metadata: { category: "app-actions" },
    input: { message: "Am I able to reset the simulation completely? wiping all the routes and stations?", networkRoutes: [] },
    expectedOutput: {
      expectToolCalls: [{ name: "reset_network", argsMatch: { target: "empty" } }],
      forbidToolCalls: [{ name: "highlight_area" }, { name: "drop_pin" }, { name: "draw_corridor" }],
    },
  },

  // ── knowledge ────────────────────────────────────────────────────────────
  // Answerable only from what the assistant knows about the app plus the `ui`
  // snapshot of what the user can see. Before the 2026-11 rework it had
  // neither, so "what is this heatmap?" failed twice over. The answer is text:
  // nothing needs drawing.
  {
    id: "knowledge-heatmap-visible",
    metadata: {
      category: "knowledge",
      notes: "Population Density is the only overlay on; the answer must name it instead of guessing.",
    },
    input: {
      message: "What is the heatmap that I can see on this map?",
      ui: { ...BASE_UI, viewport: VIEW_CITY_WIDE, layers: [{ id: "population", on: true }] },
    },
    expectedOutput: {
      // [\s-] also accepts "population-density heatmap".
      textChecks: { mustMatch: [{ pattern: "population[\\s-]density", flags: "i" }] },
      // Explaining a layer is no reason to shade an area.
      forbidToolCalls: [{ name: "highlight_area" }],
    },
  },
  {
    id: "knowledge-two-heatmaps",
    metadata: {
      category: "knowledge",
      notes: "Two overlays with similar colour ramps are on at once — the answer has to explain both.",
    },
    input: {
      message: "what am I looking at?",
      ui: {
        ...BASE_UI,
        viewport: VIEW_SCARBOROUGH,
        layers: [
          { id: "serviceHeatmap", on: true },
          { id: "transitDesert", on: true },
        ],
      },
    },
    expectedOutput: {
      textChecks: {
        mustMatch: [
          { pattern: "service", flags: "i" },
          { pattern: "desert", flags: "i" },
        ],
      },
    },
  },
  {
    id: "knowledge-how-to-save",
    metadata: {
      category: "knowledge",
      notes:
        "Signed out with unsaved changes: Plans needs sign-in; without it, export (GTFS / JSON) or copy the share link.",
    },
    input: {
      message: "How do I save my plan?",
      ui: { ...BASE_UI, network: { ...BASE_UI.network, unsavedChanges: true }, signedIn: false },
    },
    expectedOutput: {
      textChecks: {
        mustMatch: [
          { pattern: "plans", flags: "i" },
          { pattern: "(export|share)", flags: "i" },
          // The user is signed out and Plans only works signed in — the one
          // thing they need to know before clicking Plans.
          { pattern: "sign(ed)?[ -]?in|log(ged)?[ -]?in", flags: "i" },
        ],
      },
    },
  },

  // ── app-actions: changing the view ───────────────────────────────────────
  // View-only actions apply straight away (no confirm), so the tool_call
  // itself is the evidence.
  {
    id: "action-layer-on",
    metadata: { category: "app-actions", notes: "Every overlay starts off (BASE_UI.layers is empty)." },
    input: { message: "Turn on the transit desert layer", ui: BASE_UI },
    expectedOutput: {
      expectToolCalls: [{ name: "set_map_layers", argsContains: { layers: [{ id: "transitDesert", on: true }] } }],
    },
  },
  {
    id: "action-focus-route",
    metadata: {
      category: "app-actions",
      notes: "\"line-2\" is Line 2 Bloor–Danforth's id in the server's default network (web/src/app/map/transit-data.ts).",
    },
    input: { message: "Show me Line 2 on the map", ui: BASE_UI },
    expectedOutput: {
      expectToolCalls: [{ name: "focus", argsContains: { target: "route", routeId: "line-2" } }],
    },
  },

  // ── app-actions: the commuter simulation ─────────────────────────────────
  {
    id: "action-run-simulation",
    metadata: {
      category: "app-actions",
      notes:
        "networkRoutes REPLACES the server's default network, so the assistant's map is just this one user-drawn " +
        "line (custom-1); ui.network.customLines says the same. The simulation compares custom-* lines against " +
        "the baseline network.",
    },
    input: {
      message: "Run a simulation of my new line",
      networkRoutes: [RELIEF_LINE_NORTH],
      ui: {
        ...BASE_UI,
        viewport: VIEW_DON_MILLS_CORRIDOR,
        network: {
          ...BASE_UI.network,
          customLines: [{ id: "custom-1", name: "Relief Line North", type: "subway", stops: 4 }],
          unsavedChanges: true,
        },
      },
    },
    expectedOutput: {
      // The server tool is run_simulation; the browser receives show_simulation.
      expectToolCalls: [{ name: "show_simulation" }],
      // "…and explain the results": the answer should quote at least one
      // number from the run (time saved, % who can reach work, …).
      textChecks: { mustMatch: [{ pattern: "\\d", flags: "" }] },
    },
  },

  // ── app-actions: drafting a line (human in the loop) ─────────────────────
  // propose_line only shows a draft and a confirm card; nothing is added to
  // the user's network until they click. So the reply must not claim the
  // line already exists.
  {
    id: "action-draft-line",
    metadata: {
      category: "app-actions",
      notes: "Mutating action: the tool_call opens a confirm card, it does not add the line.",
    },
    input: {
      message: "Draft a new subway line along Eglinton Avenue East from Kennedy station to Don Mills",
      ui: { ...BASE_UI, viewport: VIEW_EGLINTON_EAST, layers: [{ id: "population", on: true }] },
    },
    expectedOutput: {
      expectToolCalls: [{ name: "propose_line", argsContains: { type: "subway" } }],
      textChecks: { mustNotMatch: CLAIMS_LINE_WAS_ADDED },
    },
  },
];
