import "server-only";

import { getProvider } from "./ai-provider";
import type { ToolDefinition } from "./ai-provider";
import { runSimulation } from "./simulation";
import type { ProposedLine, SimulationResult } from "./simulation";

// ── Models ─────────────────────────────────────────────────────────────────────

const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

// ── Shared blocks injected into planner prompts ───────────────────────────────

const QUOTE_BLOCK = `Also include a \`\`\`quote block with a single punchy sentence (max 15 words) summarising your stance — written in first person, as if speaking aloud:

\`\`\`quote
Your punchy one-liner here.
\`\`\``;


const PLANNING_RULES = `PLANNING RULES (apply to all proposals and critiques):
1. COST: Route length drives cost — every extra kilometre is expensive and adds years to delivery. Prefer compact, direct alignments. Flag any route that seems unnecessarily long.
2. POPULATION: Prioritise high-density corridors and destinations that are currently underserved or where existing stations are overcrowded. Each stop should justify its existence with clear population demand.
3. STATION SPACING: New stops must be at least 800 m from BOTH (a) existing TTC stations and (b) any stops already proposed earlier in this debate — unless the stop is an explicit transfer to that line. Stops too close to either category with no transfer justification must be relocated or cut. Additionally, no two consecutive stops on the same route may be more than 1500 m apart — if a gap would exceed this, add an intermediate stop or adjust the alignment.
4. SUBWAY ONLY: Every route proposed is a subway line. Do not suggest streetcar or bus alternatives.
5. NO SELF-CONNECTIONS: A stop on the proposed route cannot be labelled as a transfer to another stop on the same proposed route. Transfers are only valid when connecting to a different, pre-existing line.
6. MERIT-BASED SELECTION: Evaluate each candidate stop independently on cost, population served, and spacing. Do not retain a stop simply because of where it falls in the sequence — cut it if it fails on merit.`;

// ── System prompts ─────────────────────────────────────────────────────────────

const PLANNER_A_SYSTEM = `You are Alex Chen, Senior Transit Planner, Toronto. Advocate for ridership, equity, and underserved high-density areas.

For each proposed station give: nearest intersection, one-sentence justification (population served, existing station load relieved, or transfer value).

${PLANNING_RULES}

${QUOTE_BLOCK}

Write your analysis, then call the propose_route tool with your recommended route.`;

const PLANNER_B_SYSTEM = `You are Jordan Park, Infrastructure Cost Analyst, TTC. Every dollar and every kilometre must be justified.

Propose the most cost-efficient subway corridor for the given brief — independently, without reference to any other planner's work. Prioritise shorter total route length, direct alignments, and fewer high-ridership stops over broad coverage.

For each station you include, state:
- Nearest intersection
- Cost Risk 1–10 (tunnel distance to next stop — longer = higher)
- Ridership ROI 1–10 (population density served vs. construction cost)

Cut any stop where Cost Risk exceeds Ridership ROI. Flag any stop within 800 m of an existing TTC station unless it is an explicit transfer.

${PLANNING_RULES}

${QUOTE_BLOCK}

Write your analysis, then call the propose_route tool with your recommended route.`;

const NIMBY_SYSTEM = `You are Margaret Thompson, Residents' Association chair. Passionate and protective of existing residents.

Identify the 2–3 most disruptive stations. For each:
- Exact street corner affected
- Who lives there / what's disrupted
- NIMBY Resistance Score 1–10
- One concrete mitigation

Your quote must be emotional and direct — something like "Don't you dare put a construction site outside my window!" or "This will destroy our neighbourhood!"

${PLANNING_RULES}

${QUOTE_BLOCK}

Max 150 words. No route JSON.`;

const PR_SYSTEM = `You are Devon Walsh, TTC Communications Director. Protect the project from bad headlines.

For the top 3 stations rate (0–10 each):
- Displacement risk
- Construction noise (residential area?)
- Gentrification optics
- Environmental justice

Sum = Overall PR Nightmare Score /40. Flag >25 as political liability.
Also flag if the overall route is excessively long (high cost) or if any stop is too close to an existing station without a transfer benefit — both are easy targets for critics.
Recommend the single change with highest PR risk reduction. Max 150 words. No route JSON.

${PLANNING_RULES}

${QUOTE_BLOCK}`;

const REBUTTAL_SYSTEM = `You are Alex Chen and Jordan Park in joint rebuttal.

You each independently proposed a different route. Now synthesise the best of both into a single refined route:
- Stops that appear in both proposals → include unless they violate spacing rules
- Stops unique to Alex's route → keep if ridership/equity justifies the cost
- Stops unique to Jordan's route → keep if cost efficiency is the stronger argument
- For the 1–2 most contested stops: concede or replace with data-backed alternatives

State tradeoffs explicitly. Be decisive.

${PLANNING_RULES}

${QUOTE_BLOCK}

Write your analysis, then call the propose_route tool with your recommended route.`;

const COMMISSION_SYSTEM = `You are the Toronto Transit Commission Planning Committee.

Rule on each contested station:
1. Confirmed / Modified (new coords) / Rejected
2. One-line mitigation commitment per NIMBY/PR concern raised
3. Revised PR Nightmare Score /40

Ensure the final route is a subway, is as compact as possible while serving the target population, and has no stops within 800 m of an existing station unless they are explicit transfers. Then output the binding final route.

${PLANNING_RULES}

${QUOTE_BLOCK}

Write your ruling, then call the propose_route tool with the final binding route.`;

// ── Agent registry ─────────────────────────────────────────────────────────────

interface Agent {
  key: string;
  name: string;
  role: string;
  color: string;
  system: string;
  model: string;
  maxTokens: number;
}

const AGENTS: Agent[] = [
  // maxTokens for route agents raised to 900: tool call JSON (~500 tokens for 10 stops) + reasoning text
  { key: "planner_a",  name: "Alex Chen",          role: "Ridership Planner",      color: "#2563eb", system: PLANNER_A_SYSTEM,  model: SONNET, maxTokens: 900 },
  { key: "planner_b",  name: "Jordan Park",         role: "Infrastructure Analyst", color: "#16a34a", system: PLANNER_B_SYSTEM,  model: SONNET, maxTokens: 900 },
  { key: "nimby",      name: "Margaret Thompson",   role: "Neighbourhood Rep",      color: "#dc2626", system: NIMBY_SYSTEM,      model: HAIKU,  maxTokens: 300 },
  { key: "pr",         name: "Devon Walsh",         role: "PR Director",            color: "#d97706", system: PR_SYSTEM,         model: HAIKU,  maxTokens: 300 },
  { key: "rebuttal",   name: "Alex & Jordan",       role: "Joint Rebuttal",         color: "#7c3aed", system: REBUTTAL_SYSTEM,   model: SONNET, maxTokens: 900 },
  { key: "commission", name: "Planning Commission", role: "Final Decision",         color: "#64748b", system: COMMISSION_SYSTEM, model: SONNET, maxTokens: 2000 },
];

// ── Public types ───────────────────────────────────────────────────────────────

export interface ExistingStop {
  name: string;
  coords: [number, number];
  route: string;
}

export interface RouteScore {
  gapScore: number;            // 0–1: fraction of consecutive pairs within 1500m
  spacingViolations: number;   // # of proposed stops within 800m of each other
  connectivity: number;        // # of stops within 300m of an existing TTC stop
  estimatedCostBn: number;     // total km × 0.5 ($B)
  totalKm: number;
  stopCount: number;
  hardConstraintsFailed: string[];
}

export interface OrchestratorDirective {
  activeAgents: ("equity" | "cost" | "nimby" | "pr")[];
  focusPoints: string[];
  terminateEarly: boolean;
  reasoning: string;
}

export interface SimSummary {
  routeName: string;
  baselinePctAccessible: number;
  scenarioPctAccessible: number;
  accessibilityGainPct: number;
  timeSavedMin: number;
  baselineAvgTransitMin: number;
  scenarioAvgTransitMin: number;
  transferReduction: number;
  equityBaselineScore: number;
  equityScenarioScore: number;
  equityImprovement: number;
  incomeBreakdown: { baseline: Record<string, number>; scenario: Record<string, number> };
  newlyAccessibleAgents: number;
  topStressSegments: Array<{ fromStop: string; toStop: string; stressPct: number }>;
  agentCount: number;
  runDurationS: number;
}

export interface CouncilInput {
  neighbourhoods: string[];
  stations: string[];
  lineType?: string | null;
  extraContext?: string | null;
  existingLines?: ExistingStop[];
  provider?: string;
  randomizeSpeakingOrder?: boolean;
}

// ── SSE / extraction helpers ───────────────────────────────────────────────────

function sse(payload: Record<string, unknown>): string {
  return "data: " + JSON.stringify(payload) + "\n\n";
}

function extractQuote(text: string): string | null {
  const m = /```quote\s*(.*?)```/s.exec(text);
  return m ? m[1]!.trim() : null;
}

function stopsLabel(route: Record<string, unknown> | null): string {
  if (!route) return "(none)";
  const stops = route.stops as Array<{ name: string; coords: [number, number] }> | undefined;
  if (!stops?.length) return "(none)";
  return stops.map((s) => `${s.name} (${s.coords[0].toFixed(4)}, ${s.coords[1].toFixed(4)})`).join("; ");
}

// ── Tool definition ────────────────────────────────────────────────────────────

// 📖 Learn: JSON Schema describes the *shape* of the tool arguments. Both Anthropic
// and Gemini accept this same format. The model is forced to call this tool, so the
// output is always a valid, parseable object — no regex fallback needed.
const PROPOSE_ROUTE_TOOL: ToolDefinition = {
  name: "propose_route",
  description: "Submit the proposed subway route after your written analysis.",
  inputSchema: {
    type: "object",
    properties: {
      name:  { type: "string", description: "Short route name, e.g. 'Eglinton West Extension'" },
      type:  { type: "string", enum: ["subway"] },
      color: { type: "string", description: "Hex colour code, e.g. #2563eb" },
      stops: {
        type: "array",
        description: "Stops ordered along the corridor — no zigzagging. Each consecutive pair must be 800 m–1500 m apart. Toronto: lon −79.65 to −79.10, lat 43.55 to 43.85.",
        minItems: 6,
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            name:   { type: "string", description: "Nearest intersection or landmark" },
            coords: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
              description: "[longitude, latitude]",
            },
          },
          required: ["name", "coords"],
        },
      },
    },
    required: ["name", "type", "color", "stops"],
  },
};

// ── Geometry helpers ───────────────────────────────────────────────────────────

// Reorder stops into corridor sequence by projecting onto the axis connecting the
// two farthest-apart endpoints. Finding the endpoints first avoids greedy
// nearest-neighbour's tendency to snake back along already-visited segments.
// 📖 Learn: the dot product (p - A) · (B - A) gives a scalar measuring how far
// along the A→B direction each stop lies. Sorting by this scalar puts all stops
// in corridor order regardless of their original list order.
function sortRouteStops(route: Record<string, unknown>): Record<string, unknown> {
  const stops = route.stops as Array<{ name: string; coords: [number, number] }> | undefined;
  if (!stops || stops.length <= 2) return route;

  // Step 1: find the two stops that are farthest apart — these are the endpoints.
  let maxD = 0, endA = 0, endB = 1;
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const dx = stops[i]!.coords[0] - stops[j]!.coords[0];
      const dy = stops[i]!.coords[1] - stops[j]!.coords[1];
      const d = dx * dx + dy * dy;
      if (d > maxD) { maxD = d; endA = i; endB = j; }
    }
  }

  // Step 2: sort by projection onto the axis connecting the two endpoints.
  const ax = stops[endA]!.coords[0], ay = stops[endA]!.coords[1];
  const bx = stops[endB]!.coords[0], by = stops[endB]!.coords[1];
  const axisX = bx - ax, axisY = by - ay;

  const sorted = [...stops].sort((a, b) => {
    const pa = (a.coords[0] - ax) * axisX + (a.coords[1] - ay) * axisY;
    const pb = (b.coords[0] - ax) * axisX + (b.coords[1] - ay) * axisY;
    return pa - pb;
  });

  return { ...route, stops: sorted };
}

// Great-circle distance in kilometres (Haversine formula).
function haversineKm(a: [number, number], b: [number, number]): number {
  const R = 6371;
  const dLat = ((b[1] - a[1]) * Math.PI) / 180;
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const lat1 = (a[1] * Math.PI) / 180;
  const lat2 = (b[1] * Math.PI) / 180;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ── Deterministic route scoring ────────────────────────────────────────────────

// Score a proposed route against hard geometric constraints and connectivity.
// No LLM calls — pure math. Used by the orchestrator to decide which agents to activate.
export function scoreRoute(
  route: Record<string, unknown> | null,
  existingStops: ExistingStop[],
): RouteScore {
  const empty: RouteScore = {
    gapScore: 0, spacingViolations: 0, connectivity: 0,
    estimatedCostBn: 0, totalKm: 0, stopCount: 0,
    hardConstraintsFailed: ["no_route"],
  };
  if (!route) return empty;

  const stops = route.stops as Array<{ name: string; coords: [number, number] }> | undefined;
  if (!stops?.length) return empty;

  const violations: string[] = [];
  let totalKm = 0;
  let goodGaps = 0;
  let spacingViolations = 0;
  let connectivity = 0;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i]!;
    const [lon, lat] = stop.coords;

    // Bounds check
    if (lon < -79.65 || lon > -79.10 || lat < 43.55 || lat > 43.85) {
      violations.push(`${stop.name}: out of Toronto bounds`);
    }

    // Gap to next stop
    if (i < stops.length - 1) {
      const nextStop = stops[i + 1]!;
      const km = haversineKm(stop.coords, nextStop.coords);
      totalKm += km;
      if (km * 1000 > 1500) {
        violations.push(`Gap too large: ${stop.name} → ${nextStop.name} (${Math.round(km * 1000)}m)`);
      } else {
        goodGaps++;
      }
    }

    // Spacing violations between proposed stops
    for (let j = i + 1; j < stops.length; j++) {
      if (haversineKm(stop.coords, stops[j]!.coords) * 1000 < 800) {
        spacingViolations++;
      }
    }

    // Connectivity: is this stop near an existing TTC stop?
    if (existingStops.some((es) => haversineKm(stop.coords, es.coords) * 1000 < 300)) {
      connectivity++;
    }

    // Too close to existing stations without being a transfer
    const isTransfer = stop.name.toLowerCase().includes("transfer");
    if (!isTransfer) {
      const tooClose = existingStops.some(
        (es) => haversineKm(stop.coords, es.coords) * 1000 < 800,
      );
      if (tooClose) {
        violations.push(`${stop.name}: within 800m of existing station (needs Transfer label)`);
      }
    }
  }

  const totalGaps = stops.length - 1;
  return {
    gapScore: totalGaps > 0 ? goodGaps / totalGaps : 1,
    spacingViolations,
    connectivity,
    estimatedCostBn: totalKm * 0.5,
    totalKm,
    stopCount: stops.length,
    hardConstraintsFailed: violations,
  };
}

// Coordinate-based Jaccard similarity between two routes.
// Two stops are considered matching if their great-circle distance < thresholdM.
export function jaccardSimilarity(
  routeA: Record<string, unknown> | null,
  routeB: Record<string, unknown> | null,
  thresholdM = 300,
): number {
  if (!routeA || !routeB) return 0;
  const stopsA = routeA.stops as Array<{ coords: [number, number] }> | undefined;
  const stopsB = routeB.stops as Array<{ coords: [number, number] }> | undefined;
  if (!stopsA?.length || !stopsB?.length) return 0;

  let matched = 0;
  for (const a of stopsA) {
    if (stopsB.some((b) => haversineKm(a.coords, b.coords) * 1000 < thresholdM)) {
      matched++;
    }
  }
  const union = stopsA.length + stopsB.length - matched;
  return union > 0 ? matched / union : 0;
}

// Decide whether the deliberation loop should terminate.
export function shouldTerminate(
  scores: RouteScore[],
  iteration: number,
  jaccard: number,
): { done: boolean; reason: string } {
  if (iteration >= 3) return { done: true, reason: "max_iterations" };

  const allHardPassed = scores.every((s) => s.hardConstraintsFailed.length === 0);
  if (jaccard >= 0.70 && allHardPassed) {
    return { done: true, reason: "converged" };
  }

  const anyHighQuality = scores.some(
    (s) => s.gapScore >= 0.9 && s.spacingViolations === 0 && s.connectivity >= 2,
  );
  if (anyHighQuality && allHardPassed) {
    return { done: true, reason: "quality_threshold_met" };
  }

  return { done: false, reason: "" };
}

// ── Simulation helpers ─────────────────────────────────────────────────────────

// Convert raw SimulationResult to a compact, LLM-friendly summary.
// Exported so the live LangGraph council (council-graph.ts) can reuse it.
export function toSimSummary(result: SimulationResult, routeName: string): SimSummary {
  return {
    routeName,
    baselinePctAccessible:  result.baseline.pctAccessible,
    scenarioPctAccessible:  result.scenario.pctAccessible,
    accessibilityGainPct:   result.delta.accessibilityGainPct,
    timeSavedMin:           result.delta.timeSavedMin,
    baselineAvgTransitMin:  result.baseline.avgTransitMin,
    scenarioAvgTransitMin:  result.scenario.avgTransitMin,
    transferReduction:      result.delta.transferReduction,
    equityBaselineScore:    result.equity.baselineScore,
    equityScenarioScore:    result.equity.scenarioScore,
    equityImprovement:      result.delta.equityImprovement,
    incomeBreakdown: {
      baseline: result.baseline.incomeBreakdown,
      scenario: result.scenario.incomeBreakdown,
    },
    newlyAccessibleAgents:  result.delta.newlyAccessibleAgents,
    topStressSegments:      result.lineStress.slice(0, 3).map((s) => ({
      fromStop:  s.fromStop,
      toStop:    s.toStop,
      stressPct: s.stressPct,
    })),
    agentCount:   result.agentCount,
    runDurationS: result.runDurationS,
  };
}

// Convert a raw route object to the ProposedLine shape expected by runSimulation.
// Exported so the live LangGraph council (council-graph.ts) can reuse it.
export function routeToProposedLine(route: Record<string, unknown>): ProposedLine {
  const stops = route.stops as Array<{ name: string; coords: [number, number] }>;
  return {
    name:  (route.name as string)  ?? "Proposed",
    type:  (route.type as string)  ?? "subway",
    stops: stops.map((s) => ({ name: s.name, coords: s.coords })),
  };
}

// Return a role-specific sim context string for each debate agent.
// Agents only receive the dimensions relevant to their mandate.
function formatSimForAgent(
  simA: SimSummary | null,
  simB: SimSummary | null,
  agentKey: "equity" | "cost" | "nimby" | "pr",
): string {
  const sims = [simA, simB].filter((s): s is SimSummary => s !== null);
  if (sims.length === 0) return "";

  const lines: string[] = ["\n\n## Simulation data (150-agent model)"];

  for (const sim of sims) {
    if (agentKey === "equity") {
      lines.push(
        `**${sim.routeName}**: Equity ${sim.equityBaselineScore.toFixed(0)} → ${sim.equityScenarioScore.toFixed(0)} ` +
        `(${sim.equityImprovement >= 0 ? "+" : ""}${sim.equityImprovement.toFixed(1)} pts). ` +
        `Accessibility ${sim.baselinePctAccessible.toFixed(1)}% → ${sim.scenarioPctAccessible.toFixed(1)}% ` +
        `(+${sim.accessibilityGainPct.toFixed(1)}%). ${sim.newlyAccessibleAgents} newly reached. ` +
        `Income access (avg transit min) — ` +
        Object.entries(sim.incomeBreakdown.scenario).map(([k, v]) => `${k}: ${(v as number).toFixed(0)}min`).join(", "),
      );
    } else if (agentKey === "cost") {
      lines.push(
        `**${sim.routeName}**: ${sim.newlyAccessibleAgents} new riders. ` +
        `Avg time saved: ${sim.timeSavedMin > 0 ? sim.timeSavedMin.toFixed(1) + " min/rider" : "no improvement"}. ` +
        `Transfers reduced by ${sim.transferReduction.toFixed(2)}. ` +
        `Transit time: ${sim.baselineAvgTransitMin.toFixed(0)}min → ${sim.scenarioAvgTransitMin.toFixed(0)}min.`,
      );
    } else if (agentKey === "nimby") {
      const stress = sim.topStressSegments.length
        ? sim.topStressSegments.map((s) => `${s.fromStop}→${s.toStop} (${s.stressPct.toFixed(0)}% load)`).join("; ")
        : "no high-stress segments";
      lines.push(`**${sim.routeName}**: Highest-traffic segments (construction pressure): ${stress}.`);
    } else {
      // pr
      lines.push(
        `**${sim.routeName}**: +${sim.accessibilityGainPct.toFixed(1)}% accessibility gain, ` +
        `${sim.newlyAccessibleAgents} new riders. ` +
        `Equity ${sim.equityImprovement >= 0 ? "improves" : "worsens"} by ${Math.abs(sim.equityImprovement).toFixed(1)} pts. ` +
        `Commute ${sim.timeSavedMin > 0 ? "improves by " + sim.timeSavedMin.toFixed(1) + " min" : "unchanged"}.`,
      );
    }
  }
  return lines.join("\n");
}

// ── LLM helpers ────────────────────────────────────────────────────────────────

// Compress a long agent output to 3–5 bullet points via Haiku.
// Used to reduce context size before passing summaries to the commission.
async function compressAgentOutput(text: string, providerName?: string): Promise<string> {
  if (!text || text.length < 100) return text;
  let result = "";
  for await (const chunk of getProvider(providerName).streamDirect(
    "Extract 3–5 concise bullet points capturing the key transit planning arguments. Output only bullet points, no preamble.",
    [{ role: "user", content: text.slice(0, 1500) }],
    HAIKU, 150,
  )) {
    result += chunk;
  }
  return result || text.slice(0, 200);
}

// Orchestrator: given two route scores, decide which critique agents to activate
// and whether to skip ahead to synthesis.
async function orchestratorTurn(
  scoreA: RouteScore,
  scoreB: RouteScore,
  jaccard: number,
  simA: SimSummary | null,
  simB: SimSummary | null,
  providerName?: string,
): Promise<OrchestratorDirective> {
  const simSection = simA ?? simB
    ? `\nSimulation (150-agent model):\n` +
      (simA
        ? `Route A: +${simA.accessibilityGainPct.toFixed(1)}% accessibility, ` +
          `equity ${simA.equityImprovement >= 0 ? "+" : ""}${simA.equityImprovement.toFixed(1)}pts, ` +
          `${simA.newlyAccessibleAgents} new riders, time saved ${simA.timeSavedMin.toFixed(1)}min\n`
        : "") +
      (simB
        ? `Route B: +${simB.accessibilityGainPct.toFixed(1)}% accessibility, ` +
          `equity ${simB.equityImprovement >= 0 ? "+" : ""}${simB.equityImprovement.toFixed(1)}pts, ` +
          `${simB.newlyAccessibleAgents} new riders, time saved ${simB.timeSavedMin.toFixed(1)}min\n`
        : "")
    : "";

  // Derive sim-based activation flags
  const lowEquity = (simA && simA.equityImprovement < 1.0) || (simB && simB.equityImprovement < 1.0);
  const lowRidership = (simA && simA.newlyAccessibleAgents < 10) || (simB && simB.newlyAccessibleAgents < 10);
  const missesPopulation = (simA && simA.accessibilityGainPct < 1.0) && (simB && simB.accessibilityGainPct < 1.0);

  const prompt =
    `Route A (Alex - Ridership): ${scoreA.stopCount} stops, ${scoreA.totalKm.toFixed(1)}km, ` +
    `$${scoreA.estimatedCostBn.toFixed(1)}B, ${scoreA.connectivity} transfers, ` +
    `${scoreA.spacingViolations} spacing violations, gap score ${(scoreA.gapScore * 100).toFixed(0)}%\n` +
    `Violations A: ${scoreA.hardConstraintsFailed.slice(0, 3).join("; ") || "none"}\n\n` +
    `Route B (Jordan - Cost): ${scoreB.stopCount} stops, ${scoreB.totalKm.toFixed(1)}km, ` +
    `$${scoreB.estimatedCostBn.toFixed(1)}B, ${scoreB.connectivity} transfers, ` +
    `${scoreB.spacingViolations} spacing violations, gap score ${(scoreB.gapScore * 100).toFixed(0)}%\n` +
    `Violations B: ${scoreB.hardConstraintsFailed.slice(0, 3).join("; ") || "none"}\n` +
    simSection +
    `\nRoute similarity (Jaccard): ${(jaccard * 100).toFixed(0)}%\n\n` +
    `Output ONLY a JSON object:\n` +
    `{\n` +
    `  "activeAgents": ["nimby", "pr"],\n` +
    `  "focusPoints": ["reason 1", "reason 2"],\n` +
    `  "terminateEarly": false,\n` +
    `  "reasoning": "one sentence"\n` +
    `}\n\n` +
    `Rules:\n` +
    `- terminateEarly: true only if both routes have 0 hard violations, gap score ≥ 0.9, and similarity ≥ 50%\n` +
    `- Include "nimby" if spacing violations > 0 or either route passes through dense residential areas\n` +
    `- Include "pr" if cost > $3B or spacing violations > 1\n` +
    `- Include "equity" if connectivity < 2 (few connections to existing network)${lowEquity ? " — FORCE INCLUDE (equity improvement < 1pt)" : ""}\n` +
    `- Include "cost" if totalKm > 15 or estimatedCostBn > 7.5${lowRidership ? " — FORCE INCLUDE (fewer than 10 new riders)" : ""}\n` +
    (missesPopulation ? `- IMPORTANT: Both routes have <1% accessibility gain — add focus point about missing population centers\n` : "") +
    `- focusPoints: 2–3 specific issues to address (e.g. "Stop X too close to Bloor station")`;

  let raw = "";
  for await (const chunk of getProvider(providerName).streamDirect(
    "You are a transit planning orchestrator. Analyse route quality metrics and output only valid JSON.",
    [{ role: "user", content: prompt }],
    HAIKU, 300,
  )) {
    raw += chunk;
  }

  try {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) return JSON.parse(m[0]) as OrchestratorDirective;
  } catch { /* fall through to default */ }

  return {
    activeAgents: ["nimby", "pr"],
    focusPoints: ["Review spacing violations", "Assess PR risk"],
    terminateEarly: false,
    reasoning: "Default critique agents activated",
  };
}

// ── Agent turns ────────────────────────────────────────────────────────────────

// Text-only turn (NIMBY, PR) — streams text, no route output.
async function* turn(
  agent: Agent,
  threadId: string,
  prompt: string,
  providerName?: string,
): AsyncGenerator<{ chunk: string; full: string }> {
  yield { chunk: sse({ type: "agent_start", agent: agent.name, role: agent.role, color: agent.color }), full: "" };
  let full = "";
  for await (const text of getProvider(providerName).streamMessage(threadId, prompt, agent.model, agent.maxTokens)) {
    full += text;
    yield { chunk: sse({ type: "agent_text", agent: agent.name, text }), full };
  }
  const quote = extractQuote(full);
  if (quote) yield { chunk: sse({ type: "agent_quote", agent: agent.name, text: quote }), full };
  yield { chunk: sse({ type: "agent_end", agent: agent.name }), full };
}

// Route-producing turn (planners, rebuttal, commission) — two-step approach:
// Step 1: stream the written analysis via streamMessage so text is always visible.
// Step 2: force the propose_route tool call via streamMessageWithTool to get the
// validated route JSON. Splitting into two calls guarantees text_delta events fire
// before the tool call, preventing the "waiting" state when tool_choice causes the
// model to skip text and call the tool immediately.
async function* turnWithRoute(
  agent: Agent,
  threadId: string,
  prompt: string,
  providerName?: string,
): AsyncGenerator<{ chunk: string; full: string; route: Record<string, unknown> | null }> {
  yield { chunk: sse({ type: "agent_start", agent: agent.name, role: agent.role, color: agent.color }), full: "", route: null };
  let full = "";
  let route: Record<string, unknown> | null = null;

  // Step 1: stream the analysis text (no tool forcing — guarantees text output)
  for await (const text of getProvider(providerName).streamMessage(
    threadId, prompt, agent.model, agent.maxTokens,
  )) {
    full += text;
    yield { chunk: sse({ type: "agent_text", agent: agent.name, text }), full, route: null };
  }

  // Step 2: force the tool call to extract the structured route JSON.
  // The thread already has the analysis from step 1, so the model has full context.
  for await (const item of getProvider(providerName).streamMessageWithTool(
    threadId,
    "Now call the propose_route tool with your recommended route based on your analysis above.",
    PROPOSE_ROUTE_TOOL, agent.model, agent.maxTokens,
  )) {
    if (item.type === "text") {
      // Model may add brief text in step 2 — append it
      full += item.text;
      yield { chunk: sse({ type: "agent_text", agent: agent.name, text: item.text }), full, route: null };
    } else {
      // type === "tool" — the guaranteed structured route; emitted once at end of stream
      route = sortRouteStops(item.input);
    }
  }

  const quote = extractQuote(full);
  if (quote) yield { chunk: sse({ type: "agent_quote", agent: agent.name, text: quote }), full, route: null };
  yield { chunk: sse({ type: "agent_end", agent: agent.name }), full, route };
}

// Collect an entire turnWithRoute without streaming — used for the parallel seed phase.
interface CollectedTurn {
  events: string[];
  fullText: string;
  route: Record<string, unknown> | null;
}

async function collectTurnWithRoute(
  agent: Agent,
  threadId: string,
  prompt: string,
  providerName?: string,
): Promise<CollectedTurn> {
  const events: string[] = [];
  let fullText = "";
  let route: Record<string, unknown> | null = null;
  for await (const { chunk, full, route: r } of turnWithRoute(agent, threadId, prompt, providerName)) {
    events.push(chunk);
    fullText = full;
    if (r) route = r;
  }
  return { events, fullText, route };
}

// ── Data brief (no DB required — agents have Toronto knowledge) ────────────────

function buildDataBrief(neighbourhoods: string[], stationNames: string[]): string {
  const parts: string[] = [];
  if (neighbourhoods.length > 0)
    parts.push(`Target neighbourhoods: ${neighbourhoods.join(", ")}.`);
  if (stationNames.length > 0)
    parts.push(`Stations to connect: ${stationNames.join(", ")}.`);
  return parts.length > 0 ? parts.join("\n") : "No specific location data provided.";
}

// ── Council orchestration ──────────────────────────────────────────────────────

export async function* runCouncil(input: CouncilInput): AsyncGenerator<string> {
  const { neighbourhoods, stations, lineType, extraContext, existingLines = [], provider: providerName } = input;

  yield sse({ type: "status", text: "Assembling transit data…" });
  const dataBrief = buildDataBrief(neighbourhoods, stations);

  yield sse({ type: "status", text: "Creating council sessions…" });

  // Create one assistant+thread per agent, in parallel
  let sessions: Record<string, string>;
  try {
    const results = await Promise.all(
      AGENTS.map(async (ag) => {
        const aid = await getProvider(providerName).createAssistant(ag.name, ag.system);
        const tid = await getProvider(providerName).createThread(aid);
        return [ag.key, tid] as const;
      }),
    );
    sessions = Object.fromEntries(results);
  } catch (err) {
    yield sse({ type: "status", text: `Council setup failed: ${String(err)}` });
    yield sse({ type: "done" });
    return;
  }

  yield sse({ type: "status", text: "Council ready — planners deliberating in parallel…" });

  // Shared brief
  const typeStr = lineType ? `Mode preference: ${lineType}. ` : "";
  let brief =
    `# Planning Brief\n` +
    `Serve: ${neighbourhoods.join(", ") || "Toronto"}. ` +
    `Connect: ${stations.join(", ") || "None specified"}. ` +
    `${typeStr}\n\n` +
    `## Stop demand data\n${dataBrief}`;

  if (existingLines.length > 0) {
    const byRoute: Record<string, string[]> = {};
    for (const s of existingLines) {
      (byRoute[s.route] ??= []).push(`${s.name} (${s.coords[0].toFixed(4)}, ${s.coords[1].toFixed(4)})`);
    }
    const linesText = Object.entries(byRoute)
      .map(([route, stops]) => `  ${route}: ${stops.join(", ")}`)
      .join("\n");
    brief +=
      `\n\n## Existing TTC lines & stops\n${linesText}\n` +
      `TRANSFER RULE: wherever your proposed route crosses or comes within 150 m of an existing stop, ` +
      `place a stop at that exact location named '<ExistingStation> Transfer'.`;
  }

  if (extraContext) brief += `\n\nExtra context: ${extraContext}`;

  const ag = (key: string) => AGENTS.find((a) => a.key === key)!;

  try {
    // ── PHASE 1: SEED (both planners in parallel) ─────────────────────────────
    const [seedA, seedB] = await Promise.all([
      collectTurnWithRoute(
        ag("planner_a"), sessions.planner_a!,
        brief + "\n\nPropose 6–20 stations. For each, justify on merit: population density served, " +
        "distance from nearest existing station, and cost contribution to total route length. " +
        "Do not retain a stop because of where it falls in sequence — every stop must earn its place.",
        providerName,
      ),
      collectTurnWithRoute(
        ag("planner_b"), sessions.planner_b!,
        brief + "\n\nPropose 6–20 stations for the most cost-efficient corridor. " +
        "For each stop, state the nearest intersection, Cost Risk 1–10, and Ridership ROI 1–10. " +
        "Cut any stop where Cost Risk exceeds Ridership ROI. Prefer direct alignments and fewer, higher-ridership stops. " +
        "Do not retain a stop because of where it falls in sequence — every stop must earn its place.",
        providerName,
      ),
    ]);

    // Emit all collected events from both planners
    for (const chunk of seedA.events) yield chunk;
    for (const chunk of seedB.events) yield chunk;

    const routeA = seedA.route;
    const routeB = seedB.route;
    const fullA = seedA.fullText;
    const fullB = seedB.fullText;

    if (routeA) yield sse({ type: "route_update", route: routeA, round: 1 });
    if (routeB) yield sse({ type: "route_update", route: routeB, round: 2 });

    // ── PHASE 2: SCORE (deterministic, no LLM) ────────────────────────────────
    const scoreA = scoreRoute(routeA, existingLines);
    const scoreB = scoreRoute(routeB, existingLines);
    if (routeA) yield sse({ type: "score_update", agent: "Alex Chen", score: scoreA });
    if (routeB) yield sse({ type: "score_update", agent: "Jordan Park", score: scoreB });

    let jaccard = jaccardSimilarity(routeA, routeB);
    let fullN = "", fullPr = "";
    let iterationsDone = 0;

    // ── PHASE 2.5: SIM_SEED (parallel, 150 agents each) ──────────────────────
    yield sse({ type: "status", text: "Running transit simulations…" });
    let simA: SimSummary | null = null;
    let simB: SimSummary | null = null;
    const canSimA = routeA !== null && scoreA.hardConstraintsFailed.length <= 3;
    const canSimB = routeB !== null && scoreB.hardConstraintsFailed.length <= 3;

    if (canSimA || canSimB) {
      try {
        const [rawSimA, rawSimB] = await Promise.all([
          canSimA
            ? runSimulation({ proposed: [routeToProposedLine(routeA!)], agentCount: 150, seed: 42, timeRange: { startMin: 360, endMin: 1440 } })
            : Promise.resolve(null),
          canSimB
            ? runSimulation({ proposed: [routeToProposedLine(routeB!)], agentCount: 150, seed: 42, timeRange: { startMin: 360, endMin: 1440 } })
            : Promise.resolve(null),
        ]);
        if (rawSimA) {
          simA = toSimSummary(rawSimA, (routeA!.name as string) ?? "Route A");
          yield sse({ type: "sim_update", agent: "Alex Chen", sim: simA });
        }
        if (rawSimB) {
          simB = toSimSummary(rawSimB, (routeB!.name as string) ?? "Route B");
          yield sse({ type: "sim_update", agent: "Jordan Park", sim: simB });
        }
      } catch (simErr) {
        yield sse({ type: "sim_skip", reason: `Simulation error: ${String(simErr)}` });
      }
    } else {
      yield sse({ type: "sim_skip", reason: "Routes have too many hard constraint failures" });
    }

    // ── PHASE 3: ORCHESTRATE → DEBATE LOOP (max 3 iterations) ─────────────────
    for (let iter = 0; iter < 3; iter++) {
      const term = shouldTerminate([scoreA, scoreB], iter, jaccard);
      yield sse({ type: "iteration", round: iter, converged: term.done, reason: term.reason });
      if (term.done) break;

      // Orchestrator decides which agents to activate based on score vectors + sim data
      const directive = await orchestratorTurn(scoreA, scoreB, jaccard, simA, simB, providerName);
      yield sse({ type: "orchestrator", directive });

      if (directive.terminateEarly) break;

      const focusContext = directive.focusPoints.length > 0
        ? `\n\nOrchestrator focus: ${directive.focusPoints.join("; ")}`
        : "";

      // Run only the agents the orchestrator selected
      if (directive.activeAgents.includes("nimby") || directive.activeAgents.includes("equity")) {
        for await (const { chunk, full } of turn(
          ag("nimby"), sessions.nimby!,
          `Alex's proposal:\n${routeA ? JSON.stringify(routeA, null, 2) : "(none)"}\n\n` +
          `Jordan's proposal:\n${routeB ? JSON.stringify(routeB, null, 2) : "(none)"}\n\n` +
          `Affected areas: ${neighbourhoods.join(", ") || "Toronto"}.${focusContext}` +
          formatSimForAgent(simA, simB, "nimby") + "\n\n" +
          "Identify 2–3 most disruptive stations across both proposals on merit. NIMBY scores + mitigations.",
          providerName,
        )) { yield chunk; fullN = full; }
      }

      if (directive.activeAgents.includes("pr") || directive.activeAgents.includes("cost")) {
        for await (const { chunk, full } of turn(
          ag("pr"), sessions.pr!,
          `**Alex:** ${fullA.slice(0, 300)}…\n**Jordan:** ${fullB.slice(0, 300)}…\n` +
          `**NIMBY:** ${fullN.slice(0, 200) || "no concerns raised yet"}${focusContext}` +
          formatSimForAgent(simA, simB, "pr") + "\n\n" +
          "Score top 3 stations on Displacement/Noise/Gentrification/EnvJustice. Overall PR score /40. " +
          "Flag redundant stops (<800m to existing, no transfer value). One highest-impact recommendation.",
          providerName,
        )) { yield chunk; fullPr = full; }
      }

      iterationsDone++;
      jaccard = jaccardSimilarity(routeA, routeB);
    }

    // Emit final iteration state
    yield sse({ type: "iteration", round: iterationsDone, converged: true, reason: "debate_complete" });

    // ── PHASE 4: SYNTHESIZE ───────────────────────────────────────────────────
    // Compress agent outputs to reduce commission context (saves ~2000 tokens)
    const [summaryA, summaryB, summaryN, summaryPr] = await Promise.all([
      compressAgentOutput(fullA, providerName),
      compressAgentOutput(fullB, providerName),
      fullN ? compressAgentOutput(fullN, providerName) : Promise.resolve(""),
      fullPr ? compressAgentOutput(fullPr, providerName) : Promise.resolve(""),
    ]);

    // Rebuttal (only if critique agents ran — otherwise skip straight to commission)
    let fullReb = "", routeReb: Record<string, unknown> | null = null;
    if (fullN || fullPr) {
      const allProposed = [stopsLabel(routeA), stopsLabel(routeB)].filter((s) => s !== "(none)").join("; ") || "(none)";
      for await (const { chunk, full, route } of turnWithRoute(
        ag("rebuttal"), sessions.rebuttal!,
        brief +
        `\n\n**Alex summary:** ${summaryA}` +
        `\n**Jordan summary:** ${summaryB}` +
        (summaryN ? `\n**NIMBY concerns:** ${summaryN}` : "") +
        (summaryPr ? `\n**PR concerns:** ${summaryPr}` : "") +
        `\n\n## All stops proposed so far (800m exclusion zone for replacements):\n${allProposed}\n\n` +
        "Issue joint rebuttal. Defend or replace the 1–2 most contested stations on merit. " +
        "Any replacement stop must be >800m from all existing TTC stations AND all already-proposed stops above.",
        providerName,
      )) { yield chunk; fullReb = full; if (route) routeReb = route; }
      if (routeReb) yield sse({ type: "route_update", route: routeReb, round: 5 });
    }

    // Commission final ruling — receives compressed summaries and raw route JSONs
    const finalOccupied = stopsLabel(routeReb ?? routeB ?? routeA);
    const summaryReb = fullReb ? await compressAgentOutput(fullReb, providerName) : "";
    let fullCom = "", routeCom: Record<string, unknown> | null = null;
    for await (const { chunk, full, route } of turnWithRoute(
      ag("commission"), sessions.commission!,
      brief +
      `\n\n**Planner A (Alex):** ${summaryA}` +
      `\n**Planner B (Jordan):** ${summaryB}` +
      (summaryN ? `\n**NIMBY:** ${summaryN}` : "") +
      (summaryPr ? `\n**PR:** ${summaryPr}` : "") +
      (summaryReb ? `\n**Rebuttal:** ${summaryReb}` : "") +
      `\n\nRoute A JSON: ${JSON.stringify(routeA)}` +
      `\nRoute B JSON: ${JSON.stringify(routeB)}` +
      (routeReb ? `\nRebuttal route JSON: ${JSON.stringify(routeReb)}` : "") +
      `\n\n## All proposed stops (occupied — 800m exclusion zone):\n${finalOccupied}\n\n` +
      "Rule on each contested station. Commit to mitigations. Revised PR score. " +
      "Any modified stop must be >800m from existing TTC stations AND all other proposed stops listed above. " +
      "No stop may be a transfer to another stop on this same line.",
      providerName,
    )) { yield chunk; fullCom = full; if (route) routeCom = route; }

    const routeFinal = routeCom ?? routeReb ?? routeB ?? routeA;

    // ── PHASE 4.5: SIM_FINAL (500 agents on winning route) ───────────────────
    if (routeFinal) {
      yield sse({ type: "status", text: "Running final simulation…" });
      try {
        const rawFinal = await runSimulation({
          proposed: [routeToProposedLine(routeFinal)],
          agentCount: 500,
          seed: 42,
          timeRange: { startMin: 360, endMin: 1440 },
        });
        yield sse({ type: "sim_final", sim: toSimSummary(rawFinal, (routeFinal.name as string) ?? "Final Route") });
      } catch (simErr) {
        yield sse({ type: "status", text: `Final simulation error: ${String(simErr)}` });
      }
    }

    if (routeFinal) {
      let prScore: number | undefined;
      for (const src of [fullCom, fullPr]) {
        const m = /(?:PR Nightmare Score|score)[^\d]*(\d+)\s*\/\s*40/i.exec(src);
        if (m) { prScore = parseInt(m[1]!, 10); break; }
      }
      const payload: Record<string, unknown> = { type: "route_final", route: routeFinal };
      if (prScore !== undefined) payload.pr_score = prScore;
      yield sse(payload);
    }
  } catch (err) {
    yield sse({ type: "status", text: `Council error: ${String(err)}` });
  }

  yield sse({ type: "done" });
}
