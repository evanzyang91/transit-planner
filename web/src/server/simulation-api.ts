import "server-only";

/**
 * The commuter simulation's PUBLIC result shape — shared by two callers:
 *
 *   1. POST /api/simulation (the Simulate panel's own "Run" button), and
 *   2. the Ask AI `run_simulation` tool, which runs the same engine on the
 *      server and hands the result to the browser to display in that panel.
 *
 * Why this file exists: the snake_case conversion used to live inside the
 * route handler. The chat tool must produce EXACTLY what the panel expects
 * (SimulationPanel's `SimulationResult`), and a second hand-written copy of
 * the conversion would drift the first time someone renamed a field. So the
 * converters moved here and the route imports them back — one shape, one
 * place.
 *
 * 📖 Learn: the engine (simulation.ts) speaks camelCase TypeScript; the HTTP
 * API speaks snake_case JSON (it was designed to mirror an older Python
 * service). Keeping that translation in one "adapter" module is the classic
 * Adapter pattern: callers on each side never see the other side's naming.
 */

import {
  runSimulation,
  type ProposedLine,
  type SimulationResult,
  type StressSegment,
} from "./simulation";

// ── Field name conversion (moved verbatim from app/api/simulation/route.ts) ──

export function convertStressSegment(seg: StressSegment) {
  return {
    line_name: seg.lineName,
    from_stop: seg.fromStop,
    to_stop: seg.toStop,
    from_coords: seg.fromCoords,
    to_coords: seg.toCoords,
    agent_trips: seg.agentTrips,
    baseline_trips: seg.baselineTrips,
    stress_pct: seg.stressPct,
    delta_pct: seg.deltaPct,
  };
}

export function convertResult(r: SimulationResult, scenarioName: string, narrative: string) {
  return {
    scenario_name: scenarioName,
    agent_count: r.agentCount,
    animated_agent_count: r.animatedAgentCount,
    run_duration_s: r.runDurationS,
    has_proposed_lines: r.hasProposedLines,
    time_range: { start_min: r.timeRange.startMin, end_min: r.timeRange.endMin },
    baseline: {
      pct_accessible: r.baseline.pctAccessible,
      avg_transit_time_min: r.baseline.avgTransitMin,
      median_transit_time_min: r.baseline.medianTransitMin,
      p90_transit_time_min: r.baseline.p90TransitMin,
      avg_total_time_min: r.baseline.avgTotalMin,
      avg_transfers: r.baseline.avgTransfers,
      avg_car_time_min: r.baseline.avgCarMin,
      income_breakdown: r.baseline.incomeBreakdown,
    },
    scenario: {
      pct_accessible: r.scenario.pctAccessible,
      avg_transit_time_min: r.scenario.avgTransitMin,
      median_transit_time_min: r.scenario.medianTransitMin,
      p90_transit_time_min: r.scenario.p90TransitMin,
      avg_total_time_min: r.scenario.avgTotalMin,
      avg_transfers: r.scenario.avgTransfers,
      avg_car_time_min: r.scenario.avgCarMin,
      income_breakdown: r.scenario.incomeBreakdown,
    },
    delta: {
      time_saved_min: r.delta.timeSavedMin,
      total_time_saved_min: r.delta.totalTimeSavedMin,
      accessibility_gain_pct: r.delta.accessibilityGainPct,
      transfer_reduction: r.delta.transferReduction,
      equity_improvement: r.delta.equityImprovement,
      newly_accessible_agents: r.delta.newlyAccessibleAgents,
    },
    equity: {
      baseline_score: r.equity.baselineScore,
      scenario_score: r.equity.scenarioScore,
    },
    line_stress: r.lineStress.map(convertStressSegment),
    baseline_edge_stress: r.baselineEdgeStress.map(convertStressSegment),
    per_agent: r.perAgent.map((p) => ({
      agent_id: p.agentId,
      home_lon: p.homeLon,
      home_lat: p.homeLat,
      income: p.income,
      transit_dep: p.transitDep,
      persona: p.persona,
      purpose: p.purpose,
      baseline_time: p.baselineTime,
      scenario_time: p.scenarioTime,
      time_saved_min: p.timeSavedMin,
      newly_accessible: p.newlyAccessible,
      departure_min: p.departureMin,
      path_coords: p.pathCoords,
    })),
    narrative,
    transit_speed_source:    r.transitSpeedSource,
    transit_updated_at:      r.transitUpdatedAt,
    transit_trip_count:      r.transitTripCount,
    transit_road_multiplier: r.transitRoadMultiplier,
    transit_time_period:     r.transitTimePeriod,
    graph_stats: {
      baseline_nodes: r.graphStats.nodes,
      baseline_edges: r.graphStats.edges,
      scenario_nodes: r.graphStats.scenarioNodes,
      scenario_edges: r.graphStats.scenarioEdges,
    },
  };
}

/** Exactly what POST /api/simulation returns (and what SimulationPanel renders). */
export type SimulationApiResult = ReturnType<typeof convertResult>;

// ── Chat runner (the Ask AI `run_simulation` tool) ────────────────────────────

/**
 * Same defaults as the Simulate panel's controls (SimulationPanel.tsx:358-360),
 * so "run the simulation" from chat gives the same numbers as pressing Run with
 * the panel untouched: 6:00 → midnight.
 */
export const CHAT_SIM_DEFAULT_TIME_RANGE = { startMin: 360, endMin: 1440 } as const;

/** The engine's own seed default (route.ts) — a fixed seed makes reruns comparable. */
const CHAT_SIM_SEED = 42;

/** How many stressed segments the model sees — enough to name hotspots, not a data dump. */
const TOP_STRESS_FOR_MODEL = 5;

/**
 * Scenario label, built exactly like SimulationPanel does (SimulationPanel.tsx:366-368),
 * so the panel header reads the same whichever button started the run.
 */
export function scenarioNameFor(proposedLines: ProposedLine[]): string {
  if (proposedLines.length === 0) return "Baseline Network";
  if (proposedLines.length === 1) return proposedLines[0]?.name ?? "Proposed Line";
  return `${proposedLines.length} Custom Lines`;
}

/** "6:00–24:00" from minutes after midnight. */
function formatWindow(range: { startMin: number; endMin: number }): string {
  const clock = (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
  return `${clock(range.startMin)}–${clock(range.endMin)}`;
}

interface RunSnapshot {
  /** % of agents whose commute has a workable transit route. */
  pctAccessible: number;
  /** Mean in-vehicle + boarding + transfer-walk minutes over workable commutes. */
  avgTransitMin: number;
  avgTransfers: number;
  /** Income- and dependence-weighted share of agents with a workable commute (0–100). */
  equityScore: number;
}

/** What the MODEL sees after a chat run — small on purpose (no per-agent data). */
export interface ChatSimulationSummary {
  scenario: string;
  agents: number;
  timeWindow: string;
  /** Lines tested on top of the built-in network (ids starting with "custom-"). */
  proposedLines: string[];
  speeds: string;
  baseline: RunSnapshot;
  /** Only present when proposed lines were tested. */
  withProposedLines?: RunSnapshot;
  /** Only present when proposed lines were tested. Positive = better. */
  delta?: {
    timeSavedMin: number;
    accessibilityGainPct: number;
    newlyAccessibleTrips: number;
    equityImprovement: number;
    transferReduction: number;
  };
  /** Busiest segments (load relative to the busiest segment in the run = 100%). */
  topStressedSegments: Array<{
    line: string;
    from: string;
    to: string;
    stressPct: number;
    /** Existing lines only: + means the proposal RELIEVED this segment. */
    deltaPct: number;
    onProposedLine: boolean;
  }>;
  note: string;
}

function summarise(result: SimulationResult, scenario: string, proposedLines: ProposedLine[]): ChatSimulationSummary {
  const hasProposed = result.hasProposedLines;

  // Merge proposed-line segments and existing-line segments, then keep the
  // busiest few. Both lists share one denominator (the run's busiest segment),
  // so their stressPct values are directly comparable.
  const allSegments = [
    ...result.lineStress.map((s) => ({ seg: s, onProposedLine: true })),
    ...result.baselineEdgeStress.map((s) => ({ seg: s, onProposedLine: false })),
  ];
  allSegments.sort((a, b) => b.seg.stressPct - a.seg.stressPct);
  const topStressedSegments = allSegments.slice(0, TOP_STRESS_FOR_MODEL).map(({ seg, onProposedLine }) => ({
    line: seg.lineName,
    from: seg.fromStop,
    to: seg.toStop,
    stressPct: seg.stressPct,
    deltaPct: seg.deltaPct,
    onProposedLine,
  }));

  const baseline: RunSnapshot = {
    pctAccessible: result.baseline.pctAccessible,
    avgTransitMin: result.baseline.avgTransitMin,
    avgTransfers: result.baseline.avgTransfers,
    equityScore: result.equity.baselineScore,
  };

  return {
    scenario,
    agents: result.agentCount,
    timeWindow: formatWindow(result.timeRange),
    proposedLines: proposedLines.map((l) => l.name),
    speeds: "typical speeds (fallback) — live TTC speeds are only used when the panel's own Run button fetches them",
    baseline,
    ...(hasProposed
      ? {
          withProposedLines: {
            pctAccessible: result.scenario.pctAccessible,
            avgTransitMin: result.scenario.avgTransitMin,
            avgTransfers: result.scenario.avgTransfers,
            equityScore: result.equity.scenarioScore,
          },
          delta: {
            timeSavedMin: result.delta.timeSavedMin,
            accessibilityGainPct: result.delta.accessibilityGainPct,
            // The engine counts trip LEGS in the time window that became
            // possible by transit (the panel labels this "agents").
            newlyAccessibleTrips: result.delta.newlyAccessibleAgents,
            equityImprovement: result.delta.equityImprovement,
            transferReduction: result.delta.transferReduction,
          },
        }
      : {}),
    topStressedSegments,
    note: hasProposed
      ? "Baseline = the built-in TTC network (subway, LRT, streetcars and all bus routes); the scenario adds the user's custom lines on top."
      : "No custom lines are on the map, so this run only measures the built-in TTC network — there is nothing to compare yet.",
  };
}

/**
 * Run the commuter simulation for the Ask AI assistant.
 *
 * Differences from the panel's Run button, all deliberate:
 *  • no live-speed prefetch (GET /api/transit-speeds) — the engine falls back
 *    to its typical per-mode speeds. Keeps the chat turn fast and predictable.
 *  • no narrative (narrate=false) — the assistant explains the result itself,
 *    so a second LLM call would only add latency.
 *
 * `signal`: the engine is synchronous CPU work once its population data has
 * loaded, so it cannot be interrupted midway. We check the signal before and
 * after the run, so an abandoned request at least doesn't ship a result.
 * 📖 Learn: AbortSignal.throwIfAborted() throws the signal's `reason` (an
 * "AbortError" by default) if the caller has already called abort().
 */
export async function runSimulationForChat(opts: {
  proposedLines: ProposedLine[];
  agentCount: number;
  timeRange?: { startMin: number; endMin: number };
  signal?: AbortSignal;
}): Promise<{ apiResult: SimulationApiResult; summary: ChatSimulationSummary }> {
  opts.signal?.throwIfAborted();

  const timeRange = opts.timeRange ?? CHAT_SIM_DEFAULT_TIME_RANGE;
  const scenario = scenarioNameFor(opts.proposedLines);

  const result = await runSimulation({
    proposed: opts.proposedLines,
    agentCount: opts.agentCount,
    seed: CHAT_SIM_SEED,
    timeRange: { startMin: timeRange.startMin, endMin: timeRange.endMin },
    // transitSpeeds omitted on purpose → engine fallback speeds (see above).
  });

  opts.signal?.throwIfAborted();

  return {
    apiResult: convertResult(result, scenario, ""),
    summary: summarise(result, scenario, opts.proposedLines),
  };
}
