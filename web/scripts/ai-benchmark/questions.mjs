// The benchmark question set for the "Ask AI" map assistant (POST /api/ai/chat
// with mapTools: true). Each item's `expectedOutput` is an INVARIANT to check
// against what actually happened, not literal text — the model's wording
// varies run to run, but "did it call rank_service_areas with order:
// best_served" does not.
//
// Two different places an invariant can be checked (see ../ai-benchmark/run.mjs):
//   - `expectToolCalls` / `forbidToolCalls`: matched against the `tool_call`
//     SSE events the client actually receives. Only the 4 WRITE tools
//     (show_area→highlight_area, draw_corridor, drop_pin, fly_to) ever appear
//     here, and only when the server actually rendered them.
//   - `expectTrace` / `forbidTrace`: matched against the Langfuse trace this
//     run tagged with `benchmarkRunId` (see ToolContext.benchmarkRunId in
//     web/src/server/map-data/tools.ts). This is the ONLY way to see which
//     READ tool ran (rank_service_areas, query_population, estimate_ridership,
//     query_network, describe_location, network_coverage) — those never touch
//     the client stream at all.
//
// 📖 Learn: this is why the runner needs both the SSE parser AND a Langfuse
// trace lookup per item — the client stream alone is blind to half the tools.

/** A real, inhabited residential point (Yonge & Eglinton area). */
const INHABITED_POINT = [-79.4025, 43.7053];

/** A point well out in Lake Ontario — no census population, must be rejected. */
const LAKE_POINT = [-79.38, 43.6];

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
];
