import { describe, expect, it } from "vitest";
import {
  LATENCY_METRICS,
  argsMatch,
  containsDeep,
  findCalls,
  itemLatencyScores,
  itemNeedsTrace,
  percentile,
  runLatencyScores,
  scoreItem,
  summarizeLatency,
} from "./scoring.mjs";

/** An output in the shape run.mjs's task returns; override what a test needs. */
function makeOutput(overrides = {}) {
  return {
    text: "",
    turnToolCalls: [[]],
    traceToolCalls: [],
    errors: [],
    turns: [],
    ...overrides,
  };
}

describe("containsDeep (argsContains)", () => {
  const setLayersArgs = {
    layers: [
      { id: "population", on: false },
      { id: "transitDesert", on: true },
    ],
  };

  it("matches an object on a subset of its keys", () => {
    expect(containsDeep({ target: "route", routeId: "line-2", routeName: "Line 2" }, { target: "route" })).toBe(true);
    expect(containsDeep({ target: "route" }, { target: "neighbourhood" })).toBe(false);
    expect(containsDeep({ target: "route" }, { routeId: "line-2" })).toBe(false);
  });

  it("matches an array when every expected item matches some actual item, in any order", () => {
    expect(containsDeep(setLayersArgs, { layers: [{ id: "transitDesert", on: true }] })).toBe(true);
    expect(containsDeep(setLayersArgs, { layers: [{ id: "transitDesert" }, { id: "population" }] })).toBe(true);
    expect(containsDeep(setLayersArgs, { layers: [{ id: "transitDesert", on: false }] })).toBe(false);
    expect(containsDeep(setLayersArgs, { layers: [{ id: "traffic" }] })).toBe(false);
  });

  it("compares primitives strictly and never mixes up arrays and objects", () => {
    expect(containsDeep(30, 30)).toBe(true);
    expect(containsDeep("30", 30)).toBe(false);
    expect(containsDeep(null, null)).toBe(true);
    expect(containsDeep({ 0: "a" }, ["a"])).toBe(false);
    expect(containsDeep(["a"], { 0: "a" })).toBe(false);
    expect(containsDeep(undefined, { a: 1 })).toBe(false);
  });
});

describe("argsMatch (the original top-level matcher, unchanged)", () => {
  it("compares top-level values strictly and expected arrays as a prefix", () => {
    expect(argsMatch({ order: "best_served", bbox: [1, 2] }, { order: "best_served" })).toBe(true);
    expect(argsMatch({ stop: [-79.4025, 43.7053, 0] }, { stop: [-79.4025, 43.7053] })).toBe(true);
    expect(argsMatch({ stop: [-79.4, 43.7] }, { stop: [-79.4025, 43.7053] })).toBe(false);
    // Top-level only: a nested object is compared by identity, so it never matches.
    expect(argsMatch({ layers: [{ id: "x" }] }, { layers: [{ id: "x" }] })).toBe(false);
  });
});

describe("findCalls", () => {
  const calls = [
    { name: "focus", args: { target: "route", routeId: "line-2" } },
    { name: "focus", args: { target: "neighbourhood", name: "Malvern" } },
    { name: "fly_to", args: { bbox: [0, 0, 1, 1] } },
  ];

  it("filters by name, then by every arg filter that is given", () => {
    expect(findCalls(calls, { name: "focus" })).toHaveLength(2);
    expect(findCalls(calls, { name: "focus", argsMatch: { target: "route" } })).toHaveLength(1);
    expect(findCalls(calls, { name: "focus", argsContains: { name: "Malvern" } })).toHaveLength(1);
    expect(findCalls(calls, { name: "focus", argsMatch: { target: "route" }, argsContains: { name: "Malvern" } })).toEqual([]);
  });
});

describe("scoreItem", () => {
  it("scores an old-style output (no errors / turns / traceFound) exactly as before", () => {
    const eo = {
      expectToolCalls: [{ name: "reset_network", argsMatch: { target: "empty" } }],
      forbidToolCalls: [{ name: "highlight_area" }],
    };
    const legacyOutput = {
      text: "The reset dialog is open.",
      turnToolCalls: [[{ name: "reset_network", args: { target: "empty" } }]],
      traceToolCalls: [],
    };
    expect(scoreItem(eo, legacyOutput)).toEqual([]);

    // …and the failure wording is unchanged, so old Langfuse comments stay comparable.
    const nothingCalled = { ...legacyOutput, turnToolCalls: [[{ name: "highlight_area", args: {} }]] };
    expect(scoreItem(eo, nothingCalled)).toEqual([
      'expected client tool_call reset_network matching {"target":"empty"}, not found',
      "forbidden client tool_call highlight_area occurred",
    ]);
  });

  it("checks argsContains on client tool calls (the action-layer-on case)", () => {
    const eo = {
      expectToolCalls: [{ name: "set_map_layers", argsContains: { layers: [{ id: "transitDesert", on: true }] } }],
    };
    const switchedOn = makeOutput({
      turnToolCalls: [[{ name: "set_map_layers", args: { layers: [{ id: "transitDesert", on: true }] } }]],
    });
    const switchedOff = makeOutput({
      turnToolCalls: [[{ name: "set_map_layers", args: { layers: [{ id: "transitDesert", on: false }] } }]],
    });
    expect(scoreItem(eo, switchedOn)).toEqual([]);
    expect(scoreItem(eo, switchedOff)).toEqual([
      'expected client tool_call set_map_layers containing {"layers":[{"id":"transitDesert","on":true}]}, not found',
    ]);
  });

  it("checks argsContains on forbidden calls and on trace calls too", () => {
    const output = makeOutput({
      turnToolCalls: [[{ name: "set_map_layers", args: { layers: [{ id: "traffic", on: true }] } }]],
      traceToolCalls: [{ name: "lookup_app_docs", args: { topic: "layers" } }],
      traceFound: true,
    });
    const eo = {
      forbidToolCalls: [{ name: "set_map_layers", argsContains: { layers: [{ id: "traffic" }] } }],
      expectTrace: [{ tool: "lookup_app_docs", argsContains: { topic: "saving" } }],
    };
    expect(scoreItem(eo, output)).toEqual([
      'expected trace call to lookup_app_docs containing {"topic":"saving"}, not found',
      'forbidden client tool_call set_map_layers containing {"layers":[{"id":"traffic"}]} occurred',
    ]);
  });

  it("only looks at the last turn's client tool calls", () => {
    const eo = { expectToolCalls: [{ name: "highlight_area" }] };
    const output = makeOutput({ turnToolCalls: [[{ name: "highlight_area", args: {} }], []] });
    expect(scoreItem(eo, output)).toEqual(["expected client tool_call highlight_area matching {}, not found"]);
  });

  it("fails on recorded errors, listing them first", () => {
    const eo = { textChecks: { mustMatch: [{ pattern: "plans", flags: "i" }] } };
    const output = makeOutput({ errors: ["server sent an error event: Overloaded"], text: "" });
    const failures = scoreItem(eo, output);
    expect(failures[0]).toBe("server sent an error event: Overloaded");
    expect(failures).toHaveLength(2);
  });

  it("fails when a needed trace was not found, but not when no trace was needed or looked for", () => {
    const traceItem = { forbidTrace: [{ tool: "rank_service_areas", argsMatch: { order: "least_served" } }] };
    expect(scoreItem(traceItem, makeOutput({ traceFound: false }))).toHaveLength(1);
    expect(scoreItem(traceItem, makeOutput({ traceFound: true }))).toEqual([]);
    expect(scoreItem(traceItem, makeOutput({ traceFound: undefined }))).toEqual([]);
    expect(scoreItem({ forbidToolCalls: [{ name: "drop_pin" }] }, makeOutput({ traceFound: false }))).toEqual([]);
  });

  it("applies mustMatch and mustNotMatch to the final text", () => {
    const eo = {
      textChecks: {
        mustMatch: [
          { pattern: "service", flags: "i" },
          { pattern: "desert", flags: "i" },
        ],
        mustNotMatch: [{ pattern: "\\bI(?:['’]ve| have)? added\\b", flags: "i" }],
      },
    };
    const good = makeOutput({ text: "You're seeing the Service Heatmap and the Transit deserts layer." });
    expect(scoreItem(eo, good)).toEqual([]);

    const bad = makeOutput({ text: "I’ve added the service heatmap." });
    expect(scoreItem(eo, bad)).toEqual([
      'answer does not match /desert/i: "I’ve added the service heatmap."',
      'answer matches forbidden /\\bI(?:[\'’]ve| have)? added\\b/i ("I’ve added"): "I’ve added the service heatmap."',
    ]);
  });

  it("reports an invalid regex rule instead of crashing", () => {
    const eo = { textChecks: { mustMatch: [{ pattern: "(unclosed", flags: "" }] } };
    expect(scoreItem(eo, makeOutput({ text: "anything" }))).toEqual([
      "invalid mustMatch rule /(unclosed/ in expectedOutput",
    ]);
  });

  it("keeps the original text checks working", () => {
    const eo = { textChecks: { forbidQuestionMark: true, maxSentences: 2, forbidNarration: true } };
    expect(scoreItem(eo, makeOutput({ text: "Malvern is the biggest gap. It is shaded red." }))).toEqual([]);
    expect(scoreItem(eo, makeOutput({ text: "Let me check. Which area? Fine. Done." }))).toHaveLength(3);
  });
});

describe("itemNeedsTrace", () => {
  it("is true only for items with expectTrace or forbidTrace", () => {
    expect(itemNeedsTrace({ expectTrace: [{ tool: "network_coverage" }] })).toBe(true);
    expect(itemNeedsTrace({ forbidTrace: [] })).toBe(true);
    expect(itemNeedsTrace({ expectToolCalls: [{ name: "focus" }] })).toBe(false);
    expect(itemNeedsTrace(undefined)).toBe(false);
  });
});

describe("latency", () => {
  it("computes nearest-rank percentiles", () => {
    const tenValues = [100, 20, 30, 40, 50, 60, 70, 80, 90, 10]; // unsorted on purpose
    expect(percentile(tenValues, 50)).toBe(50);
    expect(percentile(tenValues, 90)).toBe(90);
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([], 50)).toBeUndefined();
  });

  const cleanTurn = (totalMs, extra = {}) => ({
    ok: true,
    latency: { ttfbMs: 50, firstUiEventMs: 900, firstTextMs: 1500, totalMs, ...extra },
  });
  const failedTurn = { ok: false, latency: { ttfbMs: 10, firstUiEventMs: undefined, firstTextMs: undefined, totalMs: 200 } };

  it("summarises only clean turns, counting each metric's samples separately", () => {
    const summary = summarizeLatency([
      cleanTurn(3000),
      cleanTurn(5000, { firstUiEventMs: undefined }), // a text-only answer
      failedTurn,
    ]);
    expect(summary.turnCount).toBe(3);
    expect(summary.okTurnCount).toBe(2);
    expect(summary.metrics.totalMs).toEqual({ n: 2, p50: 3000, p90: 5000, max: 5000 });
    expect(summary.metrics.firstUiEventMs).toEqual({ n: 1, p50: 900, p90: 900, max: 900 });
  });

  it("scores an item by its last turn, plus the slowest turn's total", () => {
    const scores = itemLatencyScores([cleanTurn(6000), cleanTurn(4000, { firstUiEventMs: undefined })]);
    const byName = Object.fromEntries(scores.map((score) => [score.name, score.value]));
    expect(byName).toEqual({
      "latency-ttfb-ms": 50,
      "latency-first-text-ms": 1500,
      "latency-total-ms": 4000,
      "latency-total-max-ms": 6000,
    });
    expect(scores.every((score) => score.dataType === "NUMERIC")).toBe(true);
  });

  it("gives a failing item no latency scores", () => {
    expect(itemLatencyScores([cleanTurn(3000), failedTurn])).toEqual([]);
    expect(itemLatencyScores([])).toEqual([]);
  });

  it("turns a summary into p50 / p90 run scores, skipping metrics with no samples", () => {
    const summary = summarizeLatency([cleanTurn(3000, { firstUiEventMs: undefined })]);
    const names = runLatencyScores(summary).map((score) => score.name);
    expect(names).toEqual([
      "latency-ttfb-p50-ms",
      "latency-ttfb-p90-ms",
      "latency-first-text-p50-ms",
      "latency-first-text-p90-ms",
      "latency-total-p50-ms",
      "latency-total-p90-ms",
    ]);
    expect(LATENCY_METRICS).toHaveLength(4);
  });
});
