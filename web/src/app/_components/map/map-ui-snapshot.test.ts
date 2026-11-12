import { describe, expect, it } from "vitest";
import {
  buildMapUiSnapshot,
  findNeighbourhoodByName,
  isSimulationResultLike,
  neighbourhoodNameAt,
  neighbourhoodNameKey,
  summarizeSimulation,
  toNetworkRoutesPayload,
  type MapUiStateInput,
  type NeighbourhoodFeatureLike,
} from "./map-ui-snapshot";

// A map with nothing switched on — each test flips only what it is about.
function baseInput(overrides: Partial<MapUiStateInput> = {}): MapUiStateInput {
  return {
    viewport: null,
    showHeatmap: false,
    popLoading: false,
    showCanadaPop: false,
    canadaPopLoading: false,
    showServiceHeatmap: false,
    showTransitDesert: false,
    desertComputing: false,
    showTraffic: false,
    trafficLoading: false,
    showCoverageZones: false,
    showCatchment: false,
    catchmentRadius: 800,
    showDisruption: false,
    disruptionRadius: 200,
    isochrone: { origin: null, minutes: 30, mode: "walking" },
    showLiveVehicles: false,
    showStationLabels: false,
    aiFindingsVisible: true,
    aiFindingsCount: 0,
    customOverlayLoaded: false,
    animatedAgentCount: 0,
    selectedRoute: null,
    selectedStopName: null,
    focusedNeighbourhood: null,
    selectedNeighbourhoods: [],
    simPanelVisible: false,
    plansPanelVisible: false,
    analysisPanelOpen: false,
    councilOpen: false,
    councilRunning: false,
    routes: [],
    hiddenRouteIds: new Set(),
    goTransit: false,
    unsavedChanges: false,
    simResults: null,
    darkMode: false,
    imperial: false,
    signedIn: false,
    ...overrides,
  };
}

function segment(from: string, to: string, stressPct: number, extra: Record<string, unknown> = {}) {
  return {
    from_stop: from,
    to_stop: to,
    from_coords: [-79.4, 43.65],
    to_coords: [-79.39, 43.66],
    agent_trips: 10,
    baseline_trips: 8,
    stress_pct: stressPct,
    delta_pct: -3.4,
    ...extra,
  };
}

function simResult(overrides: Record<string, unknown> = {}) {
  const runStats = {
    pct_accessible: 61.24,
    avg_transit_time_min: 40,
    median_transit_time_min: 38,
    p90_transit_time_min: 70,
    avg_total_time_min: 50,
    avg_transfers: 1.2,
    avg_car_time_min: 25,
    income_breakdown: { low: 55, mid: 50, high: 45 },
  };
  return {
    scenario_name: "Eglinton East LRT",
    agent_count: 2000,
    animated_agent_count: 500,
    run_duration_s: 12,
    has_proposed_lines: true,
    time_range: { start_min: 360, end_min: 1440 },
    baseline: runStats,
    scenario: { ...runStats, pct_accessible: 64.56 },
    delta: {
      time_saved_min: 1,
      total_time_saved_min: 3.456,
      accessibility_gain_pct: 3.3,
      transfer_reduction: 0.1,
      equity_improvement: 2.04,
      newly_accessible_agents: 42,
    },
    equity: { baseline_score: 40, scenario_score: 47 },
    line_stress: [segment("Kennedy", "Midland", 72.6, { line_name: "Eglinton East LRT" })],
    baseline_edge_stress: [
      segment("Bloor-Yonge", "Wellesley", 95.2, { line_name: "Line 1" }),
      segment("A", "B", 10),
      segment("C", "D", 50),
      segment("E", "F", 60),
      segment("G", "H", 5),
    ],
    per_agent: [{ agent_id: 1, path_coords: [[-79.4, 43.65]] }],
    narrative: "",
    graph_stats: { baseline_nodes: 1, baseline_edges: 1, scenario_nodes: 1, scenario_edges: 1 },
    ...overrides,
  };
}

describe("buildMapUiSnapshot — layers", () => {
  it("lists nothing when every overlay is off (not listed = off)", () => {
    const snapshot = buildMapUiSnapshot(baseInput());
    expect(snapshot.v).toBe(1);
    expect(snapshot.layers).toEqual([]);
  });

  it("maps each TransitMap flag to its protocol id, in MAP_LAYER_IDS order", () => {
    const snapshot = buildMapUiSnapshot(
      baseInput({
        showStationLabels: true,
        showHeatmap: true,
        showTraffic: true,
        showServiceHeatmap: true,
        showCoverageZones: true,
        showLiveVehicles: true,
        showTransitDesert: true,
        showCanadaPop: true,
        customOverlayLoaded: true,
      }),
    );
    expect(snapshot.layers.map((layer) => layer.id)).toEqual([
      "population",
      "canadaPop",
      "serviceHeatmap",
      "transitDesert",
      "traffic",
      "coverage",
      "liveVehicles",
      "stationLabels",
      "customOverlay",
    ]);
    expect(snapshot.layers.every((layer) => layer.on)).toBe(true);
  });

  it("reports loading only for layers that are switched on", () => {
    const snapshot = buildMapUiSnapshot(
      baseInput({ showHeatmap: true, popLoading: true, trafficLoading: true, canadaPopLoading: true }),
    );
    // Traffic and Canada are loading in the background but OFF, so they are not listed.
    expect(snapshot.layers).toEqual([{ id: "population", on: true, loading: true }]);
  });

  it("adds radius / isochrone details", () => {
    const snapshot = buildMapUiSnapshot(
      baseInput({
        showCatchment: true,
        catchmentRadius: 800,
        showDisruption: true,
        disruptionRadius: 200,
        isochrone: { origin: [-79.38, 43.65], minutes: 45, mode: "cycling" },
      }),
    );
    expect(snapshot.layers).toEqual([
      { id: "catchment", on: true, detail: "800 m" },
      { id: "disruption", on: true, detail: "200 m" },
      { id: "isochrone", on: true, detail: "45 min cycling" },
    ]);
  });

  it("counts AI findings only when they are visible and non-empty", () => {
    expect(buildMapUiSnapshot(baseInput({ aiFindingsVisible: true, aiFindingsCount: 0 })).layers).toEqual([]);
    expect(buildMapUiSnapshot(baseInput({ aiFindingsVisible: false, aiFindingsCount: 3 })).layers).toEqual([]);
    expect(buildMapUiSnapshot(baseInput({ aiFindingsVisible: true, aiFindingsCount: 1 })).layers).toEqual([
      { id: "aiFindings", on: true, detail: "1 annotation" },
    ]);
  });

  it("shows simulation stress when a result with segments exists, and agents while animating", () => {
    const snapshot = buildMapUiSnapshot(baseInput({ simResults: simResult(), animatedAgentCount: 480 }));
    expect(snapshot.layers).toEqual([
      { id: "simStress", on: true },
      { id: "simAgents", on: true, detail: "480 agents" },
    ]);
    const noSegments = buildMapUiSnapshot(
      baseInput({ simResults: simResult({ line_stress: [], baseline_edge_stress: [] }) }),
    );
    expect(noSegments.layers).toEqual([]);
  });
});

describe("buildMapUiSnapshot — viewport, selection, panels, network", () => {
  it("rounds the camera and keeps neighbourhoodAtCenter null vs unknown apart", () => {
    const inside = buildMapUiSnapshot(
      baseInput({
        viewport: {
          center: [-79.3832123456, 43.6532987654],
          zoom: 11.53333,
          bounds: [-79.51234567, 43.58765432, -79.25432198, 43.71234567],
          neighbourhoodAtCenter: "Yonge-Bay Corridor",
        },
      }),
    );
    expect(inside.viewport).toEqual({
      center: [-79.38321, 43.6533],
      zoom: 11.53,
      bounds: [-79.51235, 43.58765, -79.25432, 43.71235],
      neighbourhoodAtCenter: "Yonge-Bay Corridor",
    });

    const outside = buildMapUiSnapshot(
      baseInput({ viewport: { center: [-80, 44], zoom: 8, bounds: [-81, 43, -79, 45], neighbourhoodAtCenter: null } }),
    );
    expect(outside.viewport?.neighbourhoodAtCenter).toBeNull();

    const unknown = buildMapUiSnapshot(baseInput({ viewport: { center: [-80, 44], zoom: 8, bounds: [-81, 43, -79, 45] } }));
    expect(unknown.viewport && "neighbourhoodAtCenter" in unknown.viewport).toBe(false);

    expect(buildMapUiSnapshot(baseInput()).viewport).toBeUndefined();
  });

  it("omits selection when nothing is selected, and caps long names", () => {
    expect(buildMapUiSnapshot(baseInput()).selection).toBeUndefined();
    const longName = "A".repeat(200);
    const snapshot = buildMapUiSnapshot(
      baseInput({
        selectedRoute: { id: "custom-3", name: longName },
        selectedStopName: "Kennedy",
        focusedNeighbourhood: "Agincourt North",
        selectedNeighbourhoods: ["Agincourt North", "Malvern East"],
      }),
    );
    expect(snapshot.selection?.routeId).toBe("custom-3");
    expect(snapshot.selection?.routeName?.length).toBe(60);
    expect(snapshot.selection?.routeName?.endsWith("…")).toBe(true);
    expect(snapshot.selection?.stopName).toBe("Kennedy");
    expect(snapshot.selection?.neighbourhood).toBe("Agincourt North");
    expect(snapshot.selection?.selectedNeighbourhoods).toEqual(["Agincourt North", "Malvern East"]);
  });

  it("derives the council state and the route panel flag", () => {
    expect(buildMapUiSnapshot(baseInput()).panels?.council).toBe("closed");
    expect(buildMapUiSnapshot(baseInput({ councilOpen: true })).panels?.council).toBe("open");
    expect(buildMapUiSnapshot(baseInput({ councilOpen: true, councilRunning: true })).panels?.council).toBe("running");
    const withRoute = buildMapUiSnapshot(
      baseInput({ selectedRoute: { id: "line-1", name: "Line 1" }, simPanelVisible: false, analysisPanelOpen: true }),
    );
    expect(withRoute.panels).toEqual({
      simulation: false,
      plans: false,
      analysis: true,
      routePanel: true,
      council: "closed",
    });
  });

  it("reports only hidden lines that are in the plan, custom lines and loaded buses", () => {
    const routes = [
      { id: "line-1", name: "Line 1", type: "subway", stops: [1, 2, 3] },
      { id: "bus-7", name: "7 Bathurst", type: "bus", stops: [1, 2] },
      { id: "custom-1", name: "Waterfront LRT", type: "lrt", stops: [1, 2, 3, 4] },
    ];
    const snapshot = buildMapUiSnapshot(
      baseInput({
        routes,
        // bus-999 is hidden but not loaded — it must not appear.
        hiddenRouteIds: new Set(["bus-7", "bus-999"]),
        goTransit: true,
        unsavedChanges: true,
      }),
    );
    expect(snapshot.network).toEqual({
      hiddenRouteIds: ["bus-7"],
      customLines: [{ id: "custom-1", name: "Waterfront LRT", type: "lrt", stops: 4 }],
      busRoutesLoaded: 1,
      goTransit: true,
      unsavedChanges: true,
    });
  });

  it("passes prefs and sign-in through", () => {
    const snapshot = buildMapUiSnapshot(baseInput({ darkMode: true, imperial: true, signedIn: true }));
    expect(snapshot.prefs).toEqual({ dark: true, imperial: true });
    expect(snapshot.signedIn).toBe(true);
  });
});

describe("simulation summary", () => {
  it("accepts a well-formed result and rejects broken ones", () => {
    expect(isSimulationResultLike(simResult())).toBe(true);
    expect(isSimulationResultLike(null)).toBe(false);
    expect(isSimulationResultLike({ scenario_name: "x" })).toBe(false);
    expect(isSimulationResultLike(simResult({ delta: { total_time_saved_min: "3" } }))).toBe(false);
    expect(isSimulationResultLike(simResult({ line_stress: [{ from_stop: "A" }] }))).toBe(false);
    expect(isSimulationResultLike(simResult({ per_agent: [{ agent_id: 1 }] }))).toBe(false);
  });

  it("summarises a scenario run: comparison numbers + top 5 stressed segments", () => {
    const summary = summarizeSimulation(simResult());
    expect(summary).toMatchObject({
      scenario: "Eglinton East LRT",
      agents: 2000,
      baselinePctAccessible: 61.2,
      scenarioPctAccessible: 64.6,
      timeSavedMin: 3.5,
      newlyAccessible: 42,
      equityImprovement: 2,
    });
    expect(summary?.topStress?.map((row) => row.stressPct)).toEqual([95, 73, 60, 50, 10]);
    expect(summary?.topStress?.[0]).toEqual({
      line: "Line 1",
      from: "Bloor-Yonge",
      to: "Wellesley",
      stressPct: 95,
      deltaPct: -3,
    });
    // No line name → no `line` key at all.
    expect(summary?.topStress?.[2] && "line" in summary.topStress[2]).toBe(false);
  });

  it("leaves comparison numbers out of a baseline-only run", () => {
    const summary = summarizeSimulation(simResult({ has_proposed_lines: false }));
    expect(summary?.baselinePctAccessible).toBe(61.2);
    expect(summary && "timeSavedMin" in summary).toBe(false);
    expect(summary && "scenarioPctAccessible" in summary).toBe(false);
  });

  it("returns null when there is no (valid) result", () => {
    expect(summarizeSimulation(null)).toBeNull();
    expect(summarizeSimulation({ nope: true })).toBeNull();
  });
});

describe("toNetworkRoutesPayload", () => {
  it("keeps ids, names, types and stop coordinates only", () => {
    const payload = toNetworkRoutesPayload([
      {
        id: "custom-1",
        name: "Waterfront LRT",
        type: "lrt",
        stops: [{ name: "Union", coords: [-79.38, 43.645] }],
        // Extra fields on real routes (colour, shape…) must not leak into the payload.
        ...({ color: "#123456", shape: [[0, 0]] } as object),
      },
    ]);
    expect(payload).toEqual([
      { id: "custom-1", name: "Waterfront LRT", type: "lrt", stops: [{ name: "Union", coords: [-79.38, 43.645] }] },
    ]);
  });

  it("passes the line's badge (shortName) through, which the server uses for names like 'Line 1'", () => {
    const payload = toNetworkRoutesPayload([
      { id: "line-1", name: "Yonge-University", shortName: "1", type: "subway", stops: [] },
      { id: "custom-2", name: "No badge", shortName: "", type: "bus", stops: [] },
    ]);
    expect(payload[0]).toEqual({ id: "line-1", name: "Yonge-University", shortName: "1", type: "subway", stops: [] });
    expect(payload[1]).not.toHaveProperty("shortName"); // empty badge → left out
  });
});

describe("neighbourhood lookups", () => {
  // Two unit squares side by side: West [0,1]×[0,1] and East [1,2]×[0,1].
  const features: NeighbourhoodFeatureLike[] = [
    {
      properties: { AREA_NAME: "Yonge-Bay Corridor", AREA_SHORT_CODE: "170" },
      geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
    },
    {
      properties: { AREA_NAME: "South Eglinton-Davisville", AREA_SHORT_CODE: "174" },
      geometry: { type: "MultiPolygon", coordinates: [[[[1, 0], [2, 0], [2, 1], [1, 1], [1, 0]]]] },
    },
  ];

  it("finds the neighbourhood containing a point", () => {
    expect(neighbourhoodNameAt([0.5, 0.5], features)).toBe("Yonge-Bay Corridor");
    expect(neighbourhoodNameAt([1.5, 0.5], features)).toBe("South Eglinton-Davisville");
    expect(neighbourhoodNameAt([5, 5], features)).toBeNull();
  });

  it("matches names loosely (case, dashes, a trailing area code)", () => {
    expect(neighbourhoodNameKey("Yonge-Bay Corridor (170)")).toBe("yongebaycorridor");
    expect(findNeighbourhoodByName(features, "yonge bay corridor")?.properties?.AREA_SHORT_CODE).toBe("170");
    expect(findNeighbourhoodByName(features, "South Eglinton–Davisville")?.properties?.AREA_SHORT_CODE).toBe("174");
    expect(findNeighbourhoodByName(features, "Scarborough Village")).toBeNull();
    expect(findNeighbourhoodByName(features, "  ")).toBeNull();
  });
});
