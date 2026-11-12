import { describe, expect, it, vi } from "vitest";

import type { SimulationResult } from "./simulation";

/**
 * pop_data is made "unavailable" so the engine falls back to its built-in
 * population points — hermetic, and still the real routing code. One small
 * run (the engine's minimum of 50 agents) checks the whole chat path end to
 * end; the converter is checked field by field against a hand-made result.
 */
vi.mock("./supabase", () => {
  const query: Record<string, unknown> = {};
  for (const method of ["from", "select", "gte", "lte", "gt", "order", "limit", "range"]) {
    query[method] = () => query;
  }
  // Awaiting the query builder resolves to an error, like an unreachable database.
  query.then = (resolve: (value: unknown) => void) => resolve({ data: null, error: { message: "offline (test)" } });
  return { supabase: query };
});

const { convertResult, runSimulationForChat, scenarioNameFor } = await import("./simulation-api");

const LINE = {
  name: "Test Relief Line",
  type: "subway",
  stops: [
    { name: "Pape", coords: [-79.3449, 43.6797] as [number, number] },
    { name: "Gerrard", coords: [-79.3447, 43.6671] as [number, number] },
    { name: "Queen", coords: [-79.3524, 43.6579] as [number, number] },
  ],
};

describe("scenarioNameFor (mirrors SimulationPanel)", () => {
  it("names the scenario like the panel header does", () => {
    expect(scenarioNameFor([])).toBe("Baseline Network");
    expect(scenarioNameFor([LINE])).toBe("Test Relief Line");
    expect(scenarioNameFor([LINE, LINE, LINE])).toBe("3 Custom Lines");
  });
});

describe("convertResult (the API's snake_case shape)", () => {
  it("maps every engine field to the name SimulationPanel reads", () => {
    const stats = {
      pctAccessible: 70,
      avgTransitMin: 30,
      medianTransitMin: 28,
      p90TransitMin: 55,
      avgTotalMin: 41,
      avgTransfers: 1.2,
      avgCarMin: 25,
      incomeBreakdown: { low: 33 },
    };
    const seg = {
      lineName: "L",
      fromStop: "A",
      toStop: "B",
      fromCoords: [1, 2] as [number, number],
      toCoords: [3, 4] as [number, number],
      agentTrips: 9,
      baselineTrips: 7,
      stressPct: 90,
      deltaPct: -5,
    };
    const engine: SimulationResult = {
      hasProposedLines: true,
      agentCount: 50,
      animatedAgentCount: 40,
      runDurationS: 0.5,
      timeRange: { startMin: 360, endMin: 1440 },
      baseline: stats,
      scenario: { ...stats, pctAccessible: 72 },
      delta: {
        timeSavedMin: 1,
        totalTimeSavedMin: 2,
        accessibilityGainPct: 2,
        transferReduction: 0.1,
        equityImprovement: 3,
        newlyAccessibleAgents: 4,
      },
      equity: { baselineScore: 60, scenarioScore: 63 },
      lineStress: [seg],
      baselineEdgeStress: [],
      perAgent: [],
      graphStats: { nodes: 1, edges: 2, scenarioNodes: 3, scenarioEdges: 4 },
      transitSpeedSource: "fallback",
      transitUpdatedAt: null,
      transitTripCount: 0,
      transitRoadMultiplier: 1,
      transitTimePeriod: "unknown",
    };
    const api = convertResult(engine, "Scenario", "Narrative");
    expect(api.scenario_name).toBe("Scenario");
    expect(api.narrative).toBe("Narrative");
    expect(api.time_range).toEqual({ start_min: 360, end_min: 1440 });
    expect(api.scenario.pct_accessible).toBe(72);
    expect(api.baseline.p90_transit_time_min).toBe(55);
    expect(api.delta.newly_accessible_agents).toBe(4);
    expect(api.equity).toEqual({ baseline_score: 60, scenario_score: 63 });
    expect(api.line_stress[0]).toEqual({
      line_name: "L",
      from_stop: "A",
      to_stop: "B",
      from_coords: [1, 2],
      to_coords: [3, 4],
      agent_trips: 9,
      baseline_trips: 7,
      stress_pct: 90,
      delta_pct: -5,
    });
    expect(api.graph_stats).toEqual({ baseline_nodes: 1, baseline_edges: 2, scenario_nodes: 3, scenario_edges: 4 });
  });
});

describe("runSimulationForChat", () => {
  it("returns the panel's result shape plus a compact summary for the model", async () => {
    const { apiResult, summary } = await runSimulationForChat({ proposedLines: [LINE], agentCount: 50 });

    // What the browser renders.
    expect(apiResult.scenario_name).toBe("Test Relief Line");
    expect(apiResult.has_proposed_lines).toBe(true);
    expect(apiResult.time_range).toEqual({ start_min: 360, end_min: 1440 });
    expect(apiResult.narrative).toBe("");
    expect(apiResult.transit_speed_source).toBe("fallback");
    expect(Array.isArray(apiResult.per_agent)).toBe(true);

    // What the model reads — small, and consistent with the full result.
    expect(summary.scenario).toBe("Test Relief Line");
    expect(summary.agents).toBe(apiResult.agent_count);
    expect(summary.timeWindow).toBe("6:00–24:00");
    expect(summary.baseline.pctAccessible).toBe(apiResult.baseline.pct_accessible);
    expect(summary.withProposedLines?.pctAccessible).toBe(apiResult.scenario.pct_accessible);
    expect(summary.delta?.timeSavedMin).toBe(apiResult.delta.time_saved_min);
    expect(summary.topStressedSegments.length).toBeLessThanOrEqual(5);
    const stress = summary.topStressedSegments.map((s) => s.stressPct);
    expect([...stress].sort((a, b) => b - a)).toEqual(stress);
    expect(JSON.stringify(summary).length).toBeLessThan(3_000);
  }, 30_000);

  it("only measures the baseline when there are no custom lines", async () => {
    const { apiResult, summary } = await runSimulationForChat({ proposedLines: [], agentCount: 50 });
    expect(apiResult.scenario_name).toBe("Baseline Network");
    expect(summary.withProposedLines).toBeUndefined();
    expect(summary.delta).toBeUndefined();
    expect(summary.note).toContain("nothing to compare");
  }, 30_000);

  it("does nothing when the request was already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runSimulationForChat({ proposedLines: [LINE], agentCount: 50, signal: controller.signal }),
    ).rejects.toThrow();
  });
});
