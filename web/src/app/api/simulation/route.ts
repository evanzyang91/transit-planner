import "server-only";
import { type NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { runSimulation, type SimulationResult, type TransitSpeedData } from "~/server/simulation";
import { convertResult } from "~/server/simulation-api";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// ── Narrative generation ───────────────────────────────────────────────────────

async function generateNarrative(result: SimulationResult, scenarioName: string): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "";

  const client = new Anthropic({ apiKey: key });
  const d = result.delta;
  const b = result.baseline;
  const s = result.scenario;

  const prompt = `You are a transit planning analyst. Write a concise 3-paragraph plain-English assessment of this scenario comparison for Toronto transit planners.

Scenario: "${scenarioName}"
Agents routed: ${result.agentCount}

Baseline: ${b.pctAccessible}% accessible, avg ${b.avgTransitMin} min transit, avg ${b.avgTransfers} transfers
Scenario: ${s.pctAccessible}% accessible, avg ${s.avgTransitMin} min transit, avg ${s.avgTransfers} transfers

Delta: ${d.timeSavedMin > 0 ? `${d.timeSavedMin} min saved per rider` : `${Math.abs(d.timeSavedMin)} min added per rider`}, ${d.newlyAccessibleAgents} agents newly reached, equity ${d.equityImprovement > 0 ? "improved" : "worsened"} by ${Math.abs(d.equityImprovement)} points.

Paragraph 1: Overall effectiveness summary. Paragraph 2: Equity and access implications. Paragraph 3: Key recommendation for planners. Keep it factual, under 200 words total.`;

  try {
    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    });
    const block = msg.content[0];
    return block?.type === "text" ? block.text : "";
  } catch {
    return "";
  }
}

// ── Field name conversion ──────────────────────────────────────────────────────
// convertResult / convertStressSegment now live in ~/server/simulation-api.ts so
// the Ask AI `run_simulation` tool produces exactly the same JSON shape as this
// route (one adapter, no second copy to drift).

// ── Endpoints ─────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  let body: {
    proposed_lines?: { name: string; type: string; stops: { name: string; coords: [number, number] }[] }[];
    agent_count?: number;
    scenario_name?: string;
    seed?: number;
    narrate?: boolean;
    time_range?: { start_min: number; end_min: number };
    transit_speeds?: TransitSpeedData;
  };

  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ detail: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const tr = body.time_range ?? { start_min: 360, end_min: 1440 };
    const result = await runSimulation({
      proposed: body.proposed_lines ?? [],
      agentCount: body.agent_count ?? 500,
      seed: body.seed ?? 42,
      timeRange: { startMin: tr.start_min, endMin: tr.end_min },
      transitSpeeds: body.transit_speeds,
    });

    const narrative =
      (body.narrate ?? false) && result.hasProposedLines
        ? await generateNarrative(result, body.scenario_name ?? "Proposed Scenario")
        : "";

    const payload = convertResult(result, body.scenario_name ?? "Baseline Network", narrative);
    return NextResponse.json(payload);
  } catch (err) {
    console.error("[simulation] run error:", err);
    return NextResponse.json(
      { detail: err instanceof Error ? err.message : "Simulation failed" },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const result = await runSimulation({ proposed: [], agentCount: 50, seed: 42, timeRange: { startMin: 360, endMin: 1440 } });
    return NextResponse.json({
      graph_loaded: true,
      stop_count: result.graphStats.nodes,
      edge_count: result.graphStats.edges,
    });
  } catch (err) {
    return NextResponse.json({ graph_loaded: false, error: String(err) }, { status: 503 });
  }
}
