import { beforeEach, describe, expect, it, vi } from "vitest";

import { haversineKm } from "~/app/map/geo-utils";
import {
  APP_ACTION_NAMES,
  ANNOTATION_TOOL_NAMES,
  PANEL_IDS,
  TOGGLEABLE_LAYER_IDS,
  parseAppAction,
  toolLabel,
  type DraftLine,
  type MapUiSnapshot,
} from "~/lib/map-assistant-protocol";
import { LOOKUP_TOPICS, lookupKnowledge } from "~/lib/project-knowledge";
import { costBn } from "../route-metrics";
import { SpatialGrid } from "./spatial-grid";
import { buildNetwork } from "./network";

/**
 * The census raster is stubbed with a hand-made strip of blocks: one row along
 * latitude 43.70 from −79.46 to −79.34, a block every 0.002° (~160 m), 100
 * people each. Synthetic on purpose — these tests check validation and the
 * catchment ARITHMETIC (compared with a brute-force oracle below), not
 * real-world geometry. Anything far from the strip (e.g. the lake at 43.60)
 * has no population, so it reads as "uninhabited".
 *
 * The simulation runner is stubbed too: its real run is covered by
 * simulation-api.test.ts, and here we only check what the tool feeds it and
 * how it reports back.
 */

const censusState = vi.hoisted(() => ({ available: true }));

const STRIP_BLOCKS = Array.from({ length: 61 }, (_, i) => ({
  coords: [Number((-79.46 + i * 0.002).toFixed(3)), 43.7] as [number, number],
  population: 100,
}));

vi.mock("./census", () => {
  const raster = {
    blocks: STRIP_BLOCKS,
    grid: new SpatialGrid(STRIP_BLOCKS, 0.5),
    totalPopulation: STRIP_BLOCKS.length * 100,
    fetchedAt: Date.now(),
  };
  return {
    getTorontoRaster: vi.fn(async () => (censusState.available ? raster : null)),
    populationInRadius: vi.fn(async () => null),
    densestBlocks: vi.fn(async () => null),
    catchmentPopulation: vi.fn(async () => null),
    populationServedByNetwork: vi.fn(async () => null),
  };
});

vi.mock("../simulation-api", () => ({
  runSimulationForChat: vi.fn(async (opts: { signal?: AbortSignal }) => {
    opts.signal?.throwIfAborted();
    return {
      apiResult: { scenario_name: "Relief Line", agent_count: 500, per_agent: [] },
      summary: { scenario: "Relief Line", agents: 500 },
    };
  }),
}));

// Imported after the mocks so the tools bind the stubbed modules.
const { ArtifactStore, MAP_TOOLS, READ_TOOL_NAMES, WRITE_TOOL_NAMES, resolveWriteTool, runReadTool } = await import("./tools");
const { resolveRouteQuery } = await import("./tools-actions");
const { runSimulationForChat } = await import("../simulation-api");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const twoStops = (lng: number, lat: number) => [
  { name: `A ${lng}`, coords: [lng, lat] },
  { name: `B ${lng}`, coords: [lng, lat - 0.01] },
];

/** A plan shaped like the real one (ids, names, badges), plus a loaded bus that collides with a streetcar name. */
const PLAN_ROUTES = [
  { id: "line-1", name: "Yonge–University", shortName: "1", type: "subway", stops: twoStops(-79.39, 43.7) },
  { id: "line-2", name: "Bloor–Danforth", shortName: "2", type: "subway", stops: twoStops(-79.38, 43.67) },
  { id: "line-5", name: "Eglinton", shortName: "5", type: "lrt", stops: twoStops(-79.4, 43.705) },
  { id: "streetcar-501", name: "Queen", shortName: "501", type: "streetcar", stops: twoStops(-79.37, 43.65) },
  { id: "streetcar-503", name: "Kingston Rd", shortName: "503", type: "streetcar", stops: twoStops(-79.3, 43.68) },
  { id: "streetcar-504", name: "King", shortName: "504", type: "streetcar", stops: twoStops(-79.36, 43.645) },
  { id: "streetcar-511", name: "Bathurst", shortName: "511", type: "streetcar", stops: twoStops(-79.41, 43.65) },
  { id: "bus-7", name: "Bathurst", shortName: "7", type: "bus", stops: twoStops(-79.42, 43.72) },
  { id: "bus-97", name: "Yonge", shortName: "97", type: "bus", stops: twoStops(-79.4, 43.75) },
  { id: "custom-0", name: "Eglinton East LRT", shortName: "EE", type: "lrt", stops: twoStops(-79.25, 43.74) },
  { id: "custom-1", name: "Relief Line", shortName: "RL", type: "subway", stops: twoStops(-79.35, 43.68) },
  { id: "custom-2", name: "Unfinished", shortName: "UN", type: "bus", stops: [{ name: "Only stop", coords: [-79.3, 43.7] }] },
];

function makeCtx(ui: MapUiSnapshot | null = null, signal?: AbortSignal) {
  return { network: buildNetwork(PLAN_ROUTES), artifacts: new ArtifactStore(), ui, signal };
}

/** Narrow a resolution for the assertions below (fails the test if it was rejected). */
async function rendered(name: string, args: Record<string, unknown>, ctx = makeCtx()) {
  const result = await resolveWriteTool(name, args, ctx);
  if (result.status !== "rendered") throw new Error(`expected rendered, got: ${result.error}`);
  return result;
}

async function rejected(name: string, args: Record<string, unknown>, ctx = makeCtx()) {
  const result = await resolveWriteTool(name, args, ctx);
  if (result.status !== "rejected") throw new Error(`expected rejected, got ${JSON.stringify(result.clientArgs)}`);
  return result.error;
}

/** The browser runs parseAppAction on every app action — what we emit must survive it unchanged. */
function expectClientAccepts(clientName: string, clientArgs: Record<string, unknown>) {
  const parsed = parseAppAction(clientName, clientArgs);
  expect(parsed, `${clientName} rejected by parseAppAction`).not.toBeNull();
  expect(parsed!.args).toEqual(clientArgs);
}

beforeEach(() => {
  censusState.available = true;
  vi.mocked(runSimulationForChat).mockClear();
});

// ── Registry ──────────────────────────────────────────────────────────────────

describe("tool registry", () => {
  it("has a fixed order: reads first, then drawings and actions", () => {
    expect(MAP_TOOLS.map((t) => t.name)).toEqual([
      "rank_service_areas",
      "query_population",
      "estimate_ridership",
      "query_network",
      "describe_location",
      "network_coverage",
      "lookup_app_docs",
      "show_area",
      "draw_corridor",
      "drop_pin",
      "fly_to",
      "reset_network",
      "set_map_layers",
      "show_isochrone",
      "focus",
      "set_route_visibility",
      "open_panel",
      "run_simulation",
      "propose_line",
    ]);
  });

  it("splits every tool into exactly one of READ / WRITE", () => {
    for (const tool of MAP_TOOLS) {
      expect(READ_TOOL_NAMES.has(tool.name) !== WRITE_TOOL_NAMES.has(tool.name), tool.name).toBe(true);
    }
  });

  it("gives every tool a human progress label", () => {
    for (const tool of MAP_TOOLS) expect(toolLabel(tool.name), tool.name).not.toBe(tool.name.replace(/_/g, " "));
  });

  it("only uses JSON Schema that both Anthropic and Gemini accept", () => {
    const FORBIDDEN = ["anyOf", "oneOf", "allOf", "additionalProperties", "$ref", "const", "minimum", "maximum"];
    const check = (schema: Record<string, unknown>, path: string) => {
      for (const key of FORBIDDEN) expect(schema, `${path} uses ${key}`).not.toHaveProperty(key);
      if (schema.enum) {
        expect(schema.type, `${path}: enums must be strings`).toBe("string");
        for (const v of schema.enum as unknown[]) expect(typeof v, path).toBe("string");
      }
      if (schema.type === "object") {
        const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
        expect(Object.keys(props).length, `${path}: objects need properties`).toBeGreaterThan(0);
        for (const [name, child] of Object.entries(props)) check(child, `${path}.${name}`);
      }
      if (schema.type === "array") check(schema.items as Record<string, unknown>, `${path}[]`);
    };
    for (const tool of MAP_TOOLS) {
      expect(tool.inputSchema.type, tool.name).toBe("object");
      check(tool.inputSchema, tool.name);
    }
  });

  it("ArtifactStore.forget drops one id, case-insensitively", () => {
    const store = new ArtifactStore();
    store.remember([{ id: "gap_1" }, { id: "gap_2" }] as never);
    store.forget(" GAP_1 ");
    expect(store.knownIds).toEqual(["gap_2"]);
  });
});

// ── lookup_app_docs ───────────────────────────────────────────────────────────

describe("lookup_app_docs", () => {
  it.each(LOOKUP_TOPICS)("returns the knowledge text for %s", async (topic) => {
    expect(await runReadTool("lookup_app_docs", { topic }, makeCtx())).toEqual({ topic, text: lookupKnowledge(topic) });
  });

  it("answers an unknown topic with the list of valid ones", async () => {
    const out = (await runReadTool("lookup_app_docs", { topic: "weather" }, makeCtx())) as { error: string };
    expect(out.error).toContain("Unknown topic");
    expect(out.error).toContain("coverage_and_gaps");
  });
});

// ── focus ─────────────────────────────────────────────────────────────────────

describe("focus → route", () => {
  it.each([
    ["line-1", "line-1"], // exact id
    ["Line 1", "line-1"], // badge
    ["the 504", "streetcar-504"], // number only
    ["King", "streetcar-504"], // exact name beats "Kingston Rd" containing "king"
    ["504 King", "streetcar-504"], // badge + name
    ["yonge-university", "line-1"], // punctuation/dash insensitive
    ["Yonge line", "line-1"], // type word prefers the subway over the loaded "Yonge" bus
    ["Bathurst streetcar", "streetcar-511"], // type word breaks the Bathurst tie
    ["the Queen line", "streetcar-501"], // a loose type word never blocks the only match
    ["Eglinton East LRT", "custom-0"], // a custom line's full name, type word and all
    ["Eglinton", "line-5"], // exact name beats the custom line that contains it
  ])("%s → %s", async (query, expectedId) => {
    const result = await rendered("focus", { target: "route", name: query });
    expect(result.clientArgs.routeId).toBe(expectedId);
    expectClientAccepts("focus", result.clientArgs);
  });

  it("names the line the way the app does", async () => {
    expect((await rendered("focus", { target: "route", name: "1" })).clientArgs.routeName).toBe("Line 1 Yonge–University");
    expect((await rendered("focus", { target: "route", name: "Queen" })).clientArgs.routeName).toBe("501 Queen");
    expect((await rendered("focus", { target: "route", name: "custom-1" })).clientArgs.routeName).toBe("Relief Line");
  });

  it("treats inherited object keys as ordinary words (no prototype lookups)", () => {
    expect(resolveRouteQuery("constructor toString", buildNetwork(PLAN_ROUTES).routes).kind).toBe("none");
  });

  it("works without short names (older clients) by reading the badge from the id", () => {
    const routes = [{ id: "line-2", name: "Bloor–Danforth", type: "subway" }];
    expect(resolveRouteQuery("Line 2", routes)).toEqual({ kind: "match", route: routes[0] });
  });

  it("refuses to guess between equally good matches", async () => {
    const error = await rejected("focus", { target: "route", name: "Bathurst" });
    expect(error).toContain("streetcar-511");
    expect(error).toContain("bus-7");
  });

  it("explains that an unloaded TTC bus route can't be selected", async () => {
    const error = await rejected("focus", { target: "route", name: "the 8 bus" });
    expect(error).toContain("8 Broadview");
    expect(error).toContain("not loaded into the user's plan");
  });

  it("rejects a line that doesn't exist, suggesting by shared words", async () => {
    const error = await rejected("focus", { target: "route", name: "Finch East Express" });
    expect(error).toContain("No line in the user's plan matches");
    expect(error).toContain("custom-0"); // "Eglinton East LRT" shares the word "east"
  });

  it("never swaps the kind of line the user named ('bus' must be a bus)", async () => {
    // The plan has a King STREETCAR; a King Street bus doesn't exist anywhere.
    const error = await rejected("focus", { target: "route", name: "King Street bus" });
    expect(error).toContain("No line in the user's plan matches");
  });

  it("matches by containment both ways ('Relief' → Relief Line, 'Eglinton Crosstown' → Eglinton)", async () => {
    expect((await rendered("focus", { target: "route", name: "Relief" })).clientArgs.routeId).toBe("custom-1");
    expect((await rendered("focus", { target: "route", name: "Eglinton Crosstown" })).clientArgs.routeId).toBe("line-5");
  });

  it("mentions when the focused line is hidden", async () => {
    const ui: MapUiSnapshot = { v: 1, layers: [], network: { hiddenRouteIds: ["line-2"] } };
    const result = await rendered("focus", { target: "route", name: "Line 2" }, makeCtx(ui));
    expect(result.modelNote).toContain("hidden");
  });
});

describe("focus → neighbourhood", () => {
  it("resolves official neighbourhoods (forgiving) and former boroughs, with a bbox", async () => {
    for (const name of ["Leaside", "Scarborough"]) {
      const result = await rendered("focus", { target: "neighbourhood", name });
      const [west, south, east, north] = result.clientArgs.bbox as [number, number, number, number];
      expect(west).toBeLessThan(east);
      expect(south).toBeLessThan(north);
      expectClientAccepts("focus", result.clientArgs);
    }
    expect((await rendered("focus", { target: "neighbourhood", name: "Leaside" })).clientArgs.name).toBe("Leaside-Bennington");
  });

  it("rejects an unknown place and lists the boroughs", async () => {
    expect(await rejected("focus", { target: "neighbourhood", name: "Atlantis" })).toContain("Former boroughs also work");
  });

  it("rejects a bad target or an empty name", async () => {
    expect(await rejected("focus", { target: "station", name: "Union" })).toContain("'route' or 'neighbourhood'");
    expect(await rejected("focus", { target: "route", name: "  " })).toContain("needs a name");
  });
});

// ── set_map_layers ────────────────────────────────────────────────────────────

describe("set_map_layers", () => {
  it("switches valid layers, keeping first-mention order and the latest value per id", async () => {
    const result = await rendered("set_map_layers", {
      layers: [
        { id: "population", on: true },
        { id: "traffic", on: false },
        { id: "population", on: false },
      ],
    });
    expect(result.clientArgs).toEqual({
      layers: [
        { id: "population", on: false },
        { id: "traffic", on: false },
      ],
    });
    expectClientAccepts("set_map_layers", result.clientArgs);
  });

  it("accepts every toggleable id", async () => {
    const layers = TOGGLEABLE_LAYER_IDS.map((id) => ({ id, on: true }));
    expect((await rendered("set_map_layers", { layers })).clientArgs.layers).toHaveLength(TOGGLEABLE_LAYER_IDS.length);
  });

  it("rejects unknown ids, non-boolean values, empty and oversized lists", async () => {
    const error = await rejected("set_map_layers", { layers: [{ id: "ridershipDemand", on: true }] });
    expect(error).toContain("population");
    expect(error).toContain("show_isochrone");
    expect(await rejected("set_map_layers", { layers: [{ id: "isochrone", on: true }] })).toContain("Invalid layer");
    expect(await rejected("set_map_layers", { layers: [{ id: "traffic", on: "yes" }] })).toContain("Invalid layer");
    expect(await rejected("set_map_layers", { layers: [] })).toContain("at least one");
    const eleven = Array.from({ length: 11 }, () => ({ id: "traffic", on: true }));
    expect(await rejected("set_map_layers", { layers: eleven })).toContain("at most 10");
  });

  it("tells the model when a layer was already in the requested state", async () => {
    const ui: MapUiSnapshot = { v: 1, layers: [{ id: "population", on: true }] };
    const result = await rendered("set_map_layers", { layers: [{ id: "population", on: true }] }, makeCtx(ui));
    expect(result.modelNote).toContain("Population Density ON (it already was)");
  });
});

// ── set_route_visibility ──────────────────────────────────────────────────────

describe("set_route_visibility", () => {
  it("resolves names, badges and ids, de-duplicated", async () => {
    const result = await rendered("set_route_visibility", { routes: ["Line 1", "line-1", "501"], visible: false });
    expect(result.clientArgs).toEqual({ routeIds: ["line-1", "streetcar-501"], visible: false });
    expectClientAccepts("set_route_visibility", result.clientArgs);
    expect(result.modelNote).toContain("still count in every measure");
  });

  it("can draw a TTC bus route that isn't loaded, and says it still isn't counted", async () => {
    const result = await rendered("set_route_visibility", { routes: ["8"], visible: true });
    expect(result.clientArgs).toEqual({ routeIds: ["bus-8"], visible: true });
    expect(result.modelNote).toContain("not loaded into the plan");
  });

  it("never hides a line of a different kind than the one named", async () => {
    expect(await rejected("set_route_visibility", { routes: ["King Street bus"], visible: false })).toContain(
      "Nothing was changed",
    );
  });

  it("changes nothing when any name is unknown or ambiguous", async () => {
    expect(await rejected("set_route_visibility", { routes: ["Line 1", "Atlantis Express"], visible: false })).toContain(
      "Nothing was changed",
    );
    expect(await rejected("set_route_visibility", { routes: ["Bathurst"], visible: false })).toContain("several lines");
  });

  it("needs a boolean `visible` and at least one route", async () => {
    expect(await rejected("set_route_visibility", { routes: ["Line 1"] })).toContain("visible");
    expect(await rejected("set_route_visibility", { routes: [], visible: true })).toContain("routes");
  });
});

// ── open_panel ────────────────────────────────────────────────────────────────

describe("open_panel", () => {
  it.each(PANEL_IDS)("opens %s", async (panel) => {
    const result = await rendered("open_panel", { panel });
    expect(result.clientArgs).toEqual({ panel });
    expectClientAccepts("open_panel", result.clientArgs);
  });

  it("rejects panels outside the enum", async () => {
    expect(await rejected("open_panel", { panel: "settings" })).toContain("simulation, plans, analysis, none");
  });

  it("warns that Plans needs sign-in when the user is signed out", async () => {
    const result = await rendered("open_panel", { panel: "plans" }, makeCtx({ v: 1, layers: [], signedIn: false }));
    expect(result.modelNote).toContain("isn't signed in");
  });
});

// ── show_isochrone ────────────────────────────────────────────────────────────

describe("show_isochrone", () => {
  const origin = [-79.3957, 43.6629];

  it("defaults to 30 min walking", async () => {
    const result = await rendered("show_isochrone", { origin });
    expect(result.clientArgs).toEqual({ origin, minutes: 30, mode: "walking" });
    expectClientAccepts("show_isochrone", result.clientArgs);
  });

  it("snaps unsupported times to the nearest band (ties go longer) and says so", async () => {
    const twenty = await rendered("show_isochrone", { origin, minutes: 20, mode: "cycling" });
    expect(twenty.clientArgs.minutes).toBe(15);
    expect(twenty.modelNote).toContain("15 was used instead of 20");
    expect((await rendered("show_isochrone", { origin, minutes: 22.5 })).clientArgs.minutes).toBe(30);
    expect((await rendered("show_isochrone", { origin, minutes: 90 })).clientArgs.minutes).toBe(60);
  });

  it("clears", async () => {
    const result = await rendered("show_isochrone", { clear: true });
    expect(result.clientArgs).toEqual({ clear: true });
    expectClientAccepts("show_isochrone", result.clientArgs);
  });

  it("rejects a missing or out-of-town origin and unsupported modes", async () => {
    expect(await rejected("show_isochrone", { minutes: 30 })).toContain("origin");
    expect(await rejected("show_isochrone", { origin: [-73.56, 45.5] })).toContain("outside the Toronto area");
    expect(await rejected("show_isochrone", { origin, mode: "transit" })).toContain("walking, cycling, driving");
  });
});

// ── run_simulation ────────────────────────────────────────────────────────────

describe("run_simulation", () => {
  it("tests the custom lines with 2+ stops, exactly like the Simulate panel, and reports skipped ones", async () => {
    const result = await rendered("run_simulation", {});
    const opts = vi.mocked(runSimulationForChat).mock.calls[0]![0];
    expect(opts.proposedLines.map((l) => l.name)).toEqual(["Eglinton East LRT", "Relief Line"]);
    expect(opts.agentCount).toBe(500);
    expect(result.clientName).toBe("show_simulation");
    expectClientAccepts("show_simulation", result.clientArgs);
    expect(result.modelNote).toContain("Simulate panel");
    expect(result.modelData).toMatchObject({ scenario: "Relief Line", skippedLinesWithUnder2Stops: ["Unfinished"] });
  });

  it.each([
    [5000, 1000],
    [10, 100],
    [250.4, 250],
    ["lots", 500],
  ])("agents %s → %s", async (agents, expected) => {
    await rendered("run_simulation", { agents });
    expect(vi.mocked(runSimulationForChat).mock.calls[0]![0].agentCount).toBe(expected);
  });

  it("reports a failed run instead of throwing", async () => {
    vi.mocked(runSimulationForChat).mockRejectedValueOnce(new Error("graph exploded"));
    expect(await rejected("run_simulation", {})).toContain("graph exploded");
  });

  it("gives up when the request was aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await rejected("run_simulation", {}, makeCtx(null, controller.signal))).toContain("cancelled");
  });
});

// ── propose_line ──────────────────────────────────────────────────────────────

describe("propose_line", () => {
  // Three stops along the populated strip, ~0.8 km apart.
  const STOPS = [
    { name: "Strip West", coords: [-79.44, 43.7] },
    { name: "Strip Middle", coords: [-79.43, 43.7] },
    { name: "Strip East", coords: [-79.42, 43.7] },
  ];

  /** Brute-force oracle: census blocks within `km` of ANY of `points`, each counted once. */
  function bruteForceCatchment(points: number[][], km: number): number {
    return STRIP_BLOCKS.filter((b) => points.some((p) => haversineKm(b.coords, p as [number, number]) <= km)).reduce(
      (sum, b) => sum + b.population,
      0,
    );
  }

  it("shows a validated draft with route-metrics cost and census catchment", async () => {
    const result = await rendered("propose_line", {
      name: "Strip Subway",
      type: "subway",
      stops: STOPS,
      rationale: "Connects the strip.",
    });
    expect(result.clientName).toBe("propose_line");
    expectClientAccepts("propose_line", result.clientArgs);

    const draft = result.clientArgs as unknown as DraftLine;
    expect(draft.draftId).toMatch(/^[0-9a-f-]{36}$/);
    expect(draft.color).toBe("#6366f1"); // subway default
    expect(draft.rationale).toBe("Connects the strip.");

    const lengthKm = haversineKm([-79.44, 43.7], [-79.43, 43.7]) + haversineKm([-79.43, 43.7], [-79.42, 43.7]);
    expect(draft.stats.lengthKm).toBe(Math.round(lengthKm * 10) / 10);
    expect(draft.stats.stopCount).toBe(3);
    expect(draft.stats.avgSpacingKm).toBe(Math.round((lengthKm / 2) * 100) / 100);
    expect(draft.stats.estCostBillions).toBe(Math.round(costBn(lengthKm, 3, "subway") * 100) / 100);
    expect(draft.stats.populationServed).toBe(bruteForceCatchment(STOPS.map((s) => s.coords), 0.8));

    expect(result.modelNote).toBe(
      "A draft is shown on the map with a confirm card. NOTHING has been added yet — the user must click 'Add to map'.",
    );
    // The plan's Line 1 stop at −79.39 already covers the east end of the catchment.
    const planStops = buildNetwork(PLAN_ROUTES).stops.map((s) => s.coords);
    const newlyReached = STRIP_BLOCKS.filter(
      (b) =>
        STOPS.some((s) => haversineKm(b.coords, s.coords as [number, number]) <= 0.8) &&
        !planStops.some((p) => haversineKm(b.coords, p) <= 0.8),
    ).reduce((sum, b) => sum + b.population, 0);
    expect(result.modelData).toMatchObject({ newPopulationReached: newlyReached, walkRadiusKm: 0.8 });
  });

  it("uses a 0.5 km walk-shed for streetcar and bus drafts, and a custom colour when valid", async () => {
    const result = await rendered("propose_line", { name: "Strip Bus", type: "bus", stops: STOPS, color: "#ff0088" });
    const draft = result.clientArgs as unknown as DraftLine;
    expect(draft.stats.populationServed).toBe(bruteForceCatchment(STOPS.map((s) => s.coords), 0.5));
    expect(draft.color).toBe("#ff0088");
    const named = await rendered("propose_line", { name: "Strip Bus", type: "bus", stops: STOPS, color: "red" });
    expect((named.clientArgs as unknown as DraftLine).color).toBe("#10b981");
  });

  it.each([
    ["no name", { name: " ", type: "subway", stops: STOPS }, "needs a name"],
    ["unknown type", { name: "X", type: "monorail", stops: STOPS }, "subway, lrt, streetcar, bus"],
    ["one stop", { name: "X", type: "subway", stops: STOPS.slice(0, 1) }, "2–40 stops"],
    [
      "41 stops",
      { name: "X", type: "bus", stops: Array.from({ length: 41 }, (_, i) => ({ name: `S${i}`, coords: [-79.46 + i * 0.003, 43.7] })) },
      "2–40 stops",
    ],
    ["missing coords", { name: "X", type: "subway", stops: [STOPS[0], { name: "Nowhere" }] }, "Stop 2 needs a name and coords"],
    ["outside Toronto", { name: "X", type: "subway", stops: [STOPS[0], { name: "Ottawa", coords: [-75.7, 45.42] }] }, "outside the Toronto area"],
    [
      "duplicate names",
      { name: "X", type: "subway", stops: [STOPS[0], { ...STOPS[1], name: "strip west" }] },
      "both named",
    ],
    [
      "same spot twice",
      { name: "X", type: "subway", stops: [STOPS[0], STOPS[1], { name: "Back again", coords: [-79.4402, 43.7] }] },
      "same spot",
    ],
    [
      "too close",
      { name: "X", type: "subway", stops: [STOPS[0], { name: "Next door", coords: [-79.43875, 43.7] }] },
      "Drop or move one",
    ],
    [
      "too far",
      { name: "X", type: "subway", stops: [STOPS[0], { name: "Far east", coords: [-79.34, 43.7] }] },
      "Add a stop in between",
    ],
    [
      "out of order",
      { name: "X", type: "subway", stops: [STOPS[0], STOPS[2], STOPS[1]] },
      "not in travel order",
    ],
    [
      "in the lake",
      { name: "X", type: "subway", stops: [{ name: "Lake A", coords: [-79.38, 43.6] }, { name: "Lake B", coords: [-79.37, 43.6] }] },
      "over water or uninhabited land",
    ],
  ])("rejects %s", async (_label, args, message) => {
    expect(await rejected("propose_line", args as Record<string, unknown>)).toContain(message);
  });

  it("still drafts when census data is down — but without a population figure", async () => {
    censusState.available = false;
    const result = await rendered("propose_line", { name: "Lake Line", type: "subway", stops: [
      { name: "Lake A", coords: [-79.38, 43.6] },
      { name: "Lake B", coords: [-79.37, 43.6] },
    ] });
    const draft = result.clientArgs as unknown as DraftLine;
    expect(draft.stats.populationServed).toBeUndefined();
    // toHaveProperty(key, matcher) instead of an object literal holding an `any` matcher (no-unsafe-assignment).
    expect(result.modelData).toHaveProperty("populationNote", expect.stringContaining("census data unavailable"));
  });
});

// ── Contract coverage ─────────────────────────────────────────────────────────

describe("every write tool emits a client name the browser knows", () => {
  it("covers the new app actions", () => {
    const known = new Set<string>([...ANNOTATION_TOOL_NAMES, ...APP_ACTION_NAMES]);
    for (const name of ["set_map_layers", "show_isochrone", "focus", "set_route_visibility", "open_panel", "show_simulation", "propose_line", "reset_network"]) {
      expect(known.has(name), name).toBe(true);
    }
  });
});
