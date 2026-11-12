"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { RouteScore, OrchestratorDirective, SimSummary } from "~/server/council";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ParsedRoute = {
  name: string;
  type: "subway" | "lrt" | "streetcar" | "bus";
  color: string;
  stops: { name: string; coords: [number, number] }[];
  prScore?: number; // /40
};

export type ToolCallEvent = {
  tool: "search_stops_near_point" | "snap_to_nearest_stop" | "check_transfer_at_location";
  agent: string;
  call_id: string;
  input: { lon: number; lat: number; radius_m?: number };
  result: unknown; // null = pending, array/object = completed
};

type AgentState = {
  agent: string;
  role: string;
  color: string;
  text: string;
  done: boolean;
  quote?: string;
  route?: ParsedRoute;
};

type ProposedRoute = { label: string; route: ParsedRoute };

type IterationInfo = {
  round: number;
  converged: boolean;
  reason: string;
};

type Session = {
  id: string;
  timestamp: Date;
  neighbourhoods: string[];
  stations: string[];
  agentStates: Record<string, AgentState>;
  statusMessages: string[];
  proposedRoutes: ProposedRoute[];
  finalRoute?: ParsedRoute;
  /** True when the panel closed or stream stopped before SSE `done`. */
  incomplete?: boolean;
  routeScores?: Record<string, RouteScore>;
  orchestratorInfo?: OrchestratorDirective | null;
  iterationInfo?: IterationInfo | null;
};

// ── Agent column order ─────────────────────────────────────────────────────────

const AGENT_ORDER = ["Alex Chen", "Jordan Park", "Margaret Thompson", "Devon Walsh", "Alex & Jordan"];

// Agent name → brand color (mirrors council.ts AGENTS registry)
const AGENTS_META: Record<string, string> = {
  "Alex Chen": "#2563eb",
  "Jordan Park": "#16a34a",
  "Margaret Thompson": "#dc2626",
  "Devon Walsh": "#d97706",
  "Alex & Jordan": "#7c3aed",
  "Planning Commission": "#64748b",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

// Vibrant, transit-map-inspired palette; cycles if more routes than entries
const ROUTE_PALETTE = [
  "#2563eb", // blue
  "#16a34a", // green
  "#dc2626", // red
  "#d97706", // amber
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
  "#65a30d", // lime
];

function routeColor(index: number): string {
  return ROUTE_PALETTE[index % ROUTE_PALETTE.length]!;
}

function extractRoute(text: string): ParsedRoute | null {
  const match = /```route\s*([\s\S]*?)```/.exec(text);
  if (!match) return null;
  try { return JSON.parse(match[1]!) as ParsedRoute; } catch { return null; }
}

function stripBlocks(text: string): string {
  return text.replace(/```(?:route|quote)\s*[\s\S]*?```/g, "").trim();
}

// Limit TTS to at most 2 sentences
function truncateToTwoSentences(text: string): string {
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  return sentences.slice(0, 2).join(" ").trim() || text.slice(0, 120);
}

async function speakQuote(agent: string, text: string): Promise<void> {
  const short = truncateToTwoSentences(text);
  try {
    const resp = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent, text: short }),
    });
    if (!resp.ok) return;
    const blob = await resp.blob();
    if (!blob.size) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => URL.revokeObjectURL(url);
    audio.play().catch(() => URL.revokeObjectURL(url));
  } catch {
    // ignore TTS errors silently
  }
}

function fmtTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ── Full-report blob ──────────────────────────────────────────────────────────

function openFullReport(
  agentStates: Record<string, AgentState>,
  finalRoute: ParsedRoute | null,
  neighbourhoods: string[],
  stations: string[],
  timestamp: Date,
) {
  const allAgents = [
    "Alex Chen", "Jordan Park", "Margaret Thompson", "Devon Walsh",
    "Alex & Jordan", "Planning Commission",
  ].filter((a) => agentStates[a]);

  const agentHTML = allAgents.map((name) => {
    const s = agentStates[name]!;
    const rawText = stripBlocks(s.text);
    return `
      <section style="margin-bottom:2rem;padding:1.25rem 1.5rem;border-radius:12px;border-left:4px solid ${s.color};background:#fafafa;">
        <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem;">
          <span style="width:10px;height:10px;border-radius:50%;background:${s.color};flex-shrink:0;"></span>
          <strong style="font-size:.95rem;color:#1c1917;">${s.agent}</strong>
          <span style="font-size:.8rem;color:#a8a29e;margin-left:.25rem;">${s.role}</span>
        </div>
        <div class="md-body" data-md="${encodeURIComponent(rawText)}" style="font-size:.875rem;line-height:1.65;color:#44403c;margin:0;"></div>
        ${s.quote ? `<blockquote style="margin:.9rem 0 0;padding:.6rem 1rem;border-left:3px solid ${s.color}40;color:${s.color};font-style:italic;font-size:.83rem;">"${s.quote}"</blockquote>` : ""}
      </section>`;
  }).join("\n");

  const stopsList = finalRoute
    ? finalRoute.stops.map((s, i) =>
        `<li style="padding:.2rem 0;font-size:.85rem;color:#44403c;">${i + 1}. ${s.name} <span style="color:#a8a29e;font-size:.78rem;">(${s.coords[1].toFixed(4)}, ${s.coords[0].toFixed(4)})</span></li>`
      ).join("")
    : "";

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${finalRoute?.name ?? "Transit Council"} — Full Report</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:780px;margin:0 auto;padding:2.5rem 1.5rem;color:#1c1917;background:#fff;}
  h1{font-size:1.5rem;font-weight:700;margin:0 0 .25rem;}
  .meta{font-size:.82rem;color:#a8a29e;margin-bottom:2rem;}
  .chips{display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1.75rem;}
  .chip{padding:.25rem .65rem;border-radius:99px;font-size:.78rem;font-weight:500;}
  .chip-nb{background:#eef2ff;color:#4f46e5;}
  .chip-st{background:#f5f5f4;color:#57534e;}
  h2{font-size:1rem;font-weight:600;color:#1c1917;margin:0 0 1rem;border-bottom:1px solid #e7e5e4;padding-bottom:.5rem;}
  .route-header{display:flex;align-items:center;gap:.75rem;padding:1rem 1.25rem;background:#f9f9f8;border-radius:10px;margin-bottom:1.5rem;}
  .route-swatch{width:36px;height:12px;border-radius:99px;}
  ul{margin:.5rem 0 0;padding-left:0;list-style:none;}
  .md-body p{margin:.4rem 0;} .md-body ul,.md-body ol{padding-left:1.25rem;margin:.4rem 0;}
  .md-body strong{font-weight:600;} .md-body h1,.md-body h2,.md-body h3{font-weight:600;margin:.75rem 0 .25rem;}
  @media print{body{padding:1rem;}}
</style>
<script src="https://cdn.jsdelivr.net/npm/marked@9/marked.min.js"><\/script>
<script>
  window.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('.md-body[data-md]').forEach(function(el) {
      el.innerHTML = marked.parse(decodeURIComponent(el.getAttribute('data-md') || ''));
    });
  });
<\/script>
</head>
<body>
<h1>${finalRoute?.name ?? "Transit Council Deliberation"}</h1>
<p class="meta">Generated ${timestamp.toLocaleString()}</p>
${(neighbourhoods.length > 0 || stations.length > 0) ? `<div class="chips">
  ${neighbourhoods.map((n) => `<span class="chip chip-nb">${n}</span>`).join("")}
  ${stations.map((s) => `<span class="chip chip-st">${s}</span>`).join("")}
</div>` : ""}
${finalRoute ? `<h2>Final Route</h2>
<div class="route-header">
  <span class="route-swatch" style="background:${finalRoute.color};"></span>
  <strong style="font-size:1rem;">${finalRoute.name}</strong>
  <span style="text-transform:capitalize;font-size:.85rem;color:#a8a29e;margin-left:.25rem;">${finalRoute.type}</span>
  <span style="margin-left:auto;font-size:.85rem;color:#a8a29e;">${finalRoute.stops.length} stations</span>
</div>
<ul>${stopsList}</ul><br>` : ""}
<h2>Council Deliberation</h2>
${agentHTML}
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html" });
  window.open(URL.createObjectURL(blob), "_blank");
}

// ── Shared styles ─────────────────────────────────────────────────────────────

// Match floating map chrome (Population Density toolbar, settings menu): same border token + lighter shadow.
const PANEL_CLASSES =
  "bg-white dark:bg-[#1c1c1e] border border-[#D7D7D7] dark:border-stone-600 rounded-xl shadow-sm";

const CARD_STYLE: React.CSSProperties = {
  border: "1px solid #d7d7d7",
  boxShadow: "none",
};

// `children?` (optional): react-markdown's Components type passes element props
// whose children may be absent (e.g. an empty paragraph), so a required prop doesn't type-check.
const MD = {
  p: ({ children }: { children?: React.ReactNode }) => <p className="mb-0.5 last:mb-0">{children}</p>,
  strong: ({ children }: { children?: React.ReactNode }) => <strong className="font-semibold text-stone-700">{children}</strong>,
  li: ({ children }: { children?: React.ReactNode }) => <li className="ml-3 list-disc">{children}</li>,
  ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-0.5">{children}</ul>,
  h1: ({ children }: { children?: React.ReactNode }) => <p className="font-semibold text-stone-700">{children}</p>,
  h2: ({ children }: { children?: React.ReactNode }) => <p className="font-semibold text-stone-600">{children}</p>,
  h3: ({ children }: { children?: React.ReactNode }) => <p className="font-medium text-stone-600">{children}</p>,
};

// ── Score card ────────────────────────────────────────────────────────────────

function RouteScoreCard({ agent, score, color }: { agent: string; score: RouteScore; color: string }) {
  const hasViolations = score.hardConstraintsFailed.length > 0;
  return (
    <div className="flex-1 min-w-0 rounded-lg px-2.5 py-2 text-[11px]" style={{ background: `${color}08`, border: `1px solid ${color}30` }}>
      <div className="flex items-center gap-1 mb-1">
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, display: "inline-block" }} />
        <span className="font-semibold truncate" style={{ color }}>{agent.split(" ")[0]}</span>
        {hasViolations
          ? <span className="ml-auto text-[10px] text-red-400 font-medium">{score.hardConstraintsFailed.length} issue{score.hardConstraintsFailed.length !== 1 ? "s" : ""}</span>
          : <span className="ml-auto text-[10px] text-emerald-500 font-medium">✓</span>
        }
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-stone-500">
        <span>{score.stopCount} stops · {score.totalKm.toFixed(1)}km</span>
        <span>${score.estimatedCostBn.toFixed(1)}B est.</span>
        <span>{score.connectivity} transfer{score.connectivity !== 1 ? "s" : ""}</span>
        <span>Gap {(score.gapScore * 100).toFixed(0)}%</span>
      </div>
      {hasViolations && (
        <p className="mt-1 text-[10px] text-red-400 truncate">{score.hardConstraintsFailed[0]}</p>
      )}
    </div>
  );
}

// ── Sim score card ────────────────────────────────────────────────────────────

function SimScoreCard({ agent, sim, color }: { agent: string; sim: SimSummary; color: string }) {
  const gained = sim.accessibilityGainPct > 0;
  return (
    <div className="flex-1 min-w-0 rounded-lg px-2.5 py-2 text-[11px]" style={{ background: `${color}06`, border: `1px solid ${color}25` }}>
      <div className="flex items-center gap-1 mb-1">
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, display: "inline-block" }} />
        <span className="font-semibold truncate" style={{ color }}>{agent.split(" ")[0]} · Sim</span>
        <span className={`ml-auto text-[10px] font-medium ${gained ? "text-emerald-500" : "text-stone-400"}`}>
          {gained ? `+${sim.accessibilityGainPct.toFixed(1)}%` : "~"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-stone-500">
        <span>{sim.newlyAccessibleAgents} new riders</span>
        <span>{sim.timeSavedMin > 0 ? `${sim.timeSavedMin.toFixed(1)}m saved` : "~"}</span>
        <span>Equity {sim.equityImprovement >= 0 ? "+" : ""}{sim.equityImprovement.toFixed(1)}pts</span>
        <span>{sim.transferReduction > 0 ? `-${sim.transferReduction.toFixed(1)} xfer` : "~"}</span>
      </div>
    </div>
  );
}

// ── Orchestrator badge ────────────────────────────────────────────────────────

const AGENT_LABEL: Record<string, string> = {
  nimby: "NIMBY",
  pr: "PR",
  equity: "Equity",
  cost: "Cost",
};

function OrchestratorBadge({ directive, iterationInfo }: { directive: OrchestratorDirective; iterationInfo: { round: number; converged: boolean; reason: string } | null }) {
  return (
    <div className="mx-4 mb-2 rounded-xl px-3 py-2 text-[11px]" style={{ background: "#f0fdfa", border: "1px solid #14b8a630" }}>
      <div className="flex items-center gap-2 mb-1">
        <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3 shrink-0 text-teal-500" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="6" cy="6" r="5"/><path d="M6 4v2l1.5 1.5"/>
        </svg>
        <span className="font-semibold text-teal-700">Orchestrator</span>
        {iterationInfo && (
          <span className="ml-auto text-[10px] text-teal-400">
            {iterationInfo.converged ? "✓ done" : `round ${iterationInfo.round + 1}/3`}
          </span>
        )}
      </div>
      <p className="text-stone-500 mb-1.5">{directive.reasoning}</p>
      <div className="flex flex-wrap gap-1">
        {directive.activeAgents.map((a) => (
          <span key={a} className="rounded-full px-2 py-0.5 font-medium text-teal-700" style={{ background: "#14b8a618" }}>
            {AGENT_LABEL[a] ?? a}
          </span>
        ))}
        {directive.focusPoints.map((fp, i) => (
          <span key={i} className="rounded-full px-2 py-0.5 text-stone-500" style={{ background: "#f0f0f0" }}>
            {fp}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Single agent card ─────────────────────────────────────────────────────────

function AgentCard({ state, isActive }: { state: AgentState; isActive: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [state.text, isActive]);

  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
      {/* Circular avatar with agent initial */}
      <div style={{ width: 28, height: 28, borderRadius: "50%", backgroundColor: state.color, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span style={{ color: "white", fontSize: 11, fontWeight: 700 }}>{state.agent[0]}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
          <span style={{ fontSize: 10, color: state.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{state.agent}</span>
          {isActive && <span className="animate-pulse" style={{ width: 5, height: 5, borderRadius: "50%", backgroundColor: state.color, display: "inline-block" }} />}
        </div>
        <div
          ref={contentRef}
          className="text-[12.5px] leading-snug text-stone-600 bg-stone-100"
          style={{ border: `1.5px solid ${state.color}22`, borderLeft: `2px solid ${state.color}60`, borderRadius: "0 10px 10px 10px", padding: "7px 11px", minHeight: 40, maxHeight: 160, overflowY: "auto" }}
        >
          {state.text
            ? <ReactMarkdown components={MD}>{stripBlocks(state.text)}</ReactMarkdown>
            : <span className="text-stone-300 italic">{isActive ? "thinking…" : "waiting"}</span>
          }
          {isActive && !state.done && (
            <span className="ml-0.5 inline-block h-3 w-0.5 animate-pulse bg-stone-400 align-middle" />
          )}
        </div>
        {state.quote && (
          <div style={{ marginTop: 5, borderRadius: 8, padding: "5px 10px", fontSize: 11, fontStyle: "italic", lineHeight: 1.5, background: `${state.color}10`, color: state.color, borderLeft: `2px solid ${state.color}55` }}>
            "{state.quote}"
          </div>
        )}
        {state.done && state.route && (
          <div className="flex items-center gap-1.5 text-[11px] bg-stone-50" style={{ marginTop: 5, borderRadius: 8, padding: "5px 10px", ...CARD_STYLE }}>
            <span style={{ height: 6, width: 12, borderRadius: 99, backgroundColor: state.route.color, flexShrink: 0, display: "inline-block" }} />
            <span className="font-medium text-stone-700 truncate">{state.route.name}</span>
            <span className="ml-auto text-stone-400 shrink-0">{state.route.stops.length}s</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── History session detail ────────────────────────────────────────────────────

function SessionDetail({ session }: { session: Session }) {
  const topAgents = AGENT_ORDER.filter((a) => session.agentStates[a]);
  const commission = session.agentStates["Planning Commission"];
  const scores = session.routeScores ?? {};
  const orchestrator = session.orchestratorInfo ?? null;
  const iteration = session.iterationInfo ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden">
      {session.incomplete && (
        <div className="mx-4 mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          Closed before the council stream finished — messages below are frozen at close time.
        </div>
      )}
      {session.statusMessages.length > 0 && (
        <div style={{ padding: "12px 16px 4px" }}>
          {session.statusMessages.slice(0, 2).map((s, i) => (
            <p key={i} className="text-center text-[11px] text-stone-400 italic">{s}</p>
          ))}
        </div>
      )}
      {topAgents.length > 0 && (
        <div style={{ padding: "8px 16px 0" }}>
          {topAgents.map((name) => (
            <AgentCard key={name} state={session.agentStates[name]!} isActive={false} />
          ))}
        </div>
      )}
      {commission && (
        <div style={{ padding: "0 16px" }}>
          <AgentCard state={commission} isActive={false} />
        </div>
      )}
      {Object.keys(scores).length > 0 && (
        <div className="px-4 pt-2 pb-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">Route Scores</p>
          <div className="flex gap-2 flex-wrap">
            {Object.entries(scores).map(([agent, score]) => {
              const agentColor = AGENTS_META[agent] ?? "#64748b";
              return <RouteScoreCard key={agent} agent={agent} score={score} color={agentColor} />;
            })}
          </div>
        </div>
      )}
      {orchestrator && (
        <div className="px-4 pt-1">
          <OrchestratorBadge directive={orchestrator} iterationInfo={iteration} />
        </div>
      )}
      {session.proposedRoutes.length > 0 && (
        <div className="px-4 pt-2 pb-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">Proposals</p>
          <div className="flex gap-2 flex-wrap">
            {session.proposedRoutes.map(({ label, route }) => (
              <div
                key={label}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]"
                style={{
                  ...CARD_STYLE,
                  opacity: session.finalRoute && (route.name !== session.finalRoute.name || route.color !== session.finalRoute.color) ? 0.5 : 1,
                  outline:
                    session.finalRoute && route.name === session.finalRoute.name && route.color === session.finalRoute.color
                      ? "1.5px solid #1c1917"
                      : "none",
                }}
              >
                <span className="h-1.5 w-3 shrink-0 rounded-full" style={{ background: route.color }} />
                <span className="font-medium text-stone-700">{route.name}</span>
                <span className="text-stone-400">·</span>
                <span className="text-stone-400">{label}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {session.finalRoute && (
        <FinalRecommendationCard
          route={session.finalRoute}
          commissionQuote={commission?.quote}
          agentStates={session.agentStates}
          neighbourhoods={session.neighbourhoods}
          stations={session.stations}
          timestamp={session.timestamp}
        />
      )}
    </div>
  );
}

// ── Final recommendation card ─────────────────────────────────────────────────

function FinalRecommendationCard({
  route,
  commissionQuote,
  agentStates,
  neighbourhoods,
  stations,
  timestamp,
  simSummary,
}: {
  route: ParsedRoute;
  commissionQuote?: string;
  agentStates: Record<string, AgentState>;
  neighbourhoods: string[];
  stations: string[];
  timestamp: Date;
  simSummary?: SimSummary | null;
}) {
  return (
    <div className="mx-4 mb-4 rounded-xl overflow-hidden bg-white border border-stone-800 dark:border-stone-400"
      style={{ boxShadow: "0 2px 8px rgba(0,0,0,0.1)" }}>
      <div className="px-4 pt-3 pb-2.5">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-stone-400">Final Recommendation</p>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="h-2.5 w-5 rounded-full shrink-0" style={{ background: route.color }} />
          <span className="text-[14px] font-bold text-stone-800">{route.name}</span>
          <span className="ml-auto text-[11px] capitalize text-stone-400">{route.type} · {route.stops.length} stations</span>
        </div>
        {commissionQuote && (
          <p className="text-[12px] text-stone-600 leading-snug italic mb-2">"{commissionQuote}"</p>
        )}
        {simSummary && (
          <div className="flex gap-3 text-[11px] text-stone-500 bg-stone-50 rounded-lg px-2.5 py-1.5 mb-2" style={{ border: "1px solid #e7e5e4" }}>
            <span className="text-emerald-600 font-medium">+{simSummary.accessibilityGainPct.toFixed(1)}% access</span>
            <span>{simSummary.newlyAccessibleAgents} new riders</span>
            <span>Equity {simSummary.equityImprovement >= 0 ? "+" : ""}{simSummary.equityImprovement.toFixed(1)}pts</span>
            {simSummary.timeSavedMin > 0 && <span>{simSummary.timeSavedMin.toFixed(1)}m saved</span>}
          </div>
        )}
        <div className="flex items-center justify-between pt-1.5 border-t border-stone-100">
          <p className="text-[11px] text-stone-400">✓ Added to map</p>
          <button
            onClick={() => openFullReport(agentStates, route, neighbourhoods, stations, timestamp)}
            className="flex items-center gap-1 text-[11px] font-medium text-stone-500 hover:text-stone-800 transition-colors"
          >
            Full report
            <svg viewBox="0 0 10 10" fill="none" className="h-2.5 w-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 8L8 2M4.5 2H8v3.5"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ChatPanel({
  open,
  onClose,
  startNew,
  neighbourhoodNames,
  stationNames,
  existingLineStops,
  onAddRoute,
  onRoutePreview,
  onToolCall,
  routePanelOpen,
  randomizeSpeakingOrder = true,
}: {
  open: boolean;
  onClose: () => void;
  startNew: boolean;
  neighbourhoodNames: string[];
  stationNames: string[];
  existingLineStops: { name: string; coords: [number, number]; route: string }[];
  onAddRoute: (route: ParsedRoute) => void;
  onRoutePreview?: (routes: ParsedRoute[] | null) => void;
  onToolCall?: (evt: ToolCallEvent) => void;
  routePanelOpen?: boolean;
  randomizeSpeakingOrder?: boolean;
}) {
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const [agentStates, setAgentStates] = useState<Record<string, AgentState>>({});
  const [statusMessages, setStatusMessages] = useState<string[]>([]);
  const [proposedRoutes, setProposedRoutes] = useState<ProposedRoute[]>([]);
  const [finalRoute, setFinalRoute] = useState<ParsedRoute | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [routeScores, setRouteScores] = useState<Record<string, RouteScore>>({});
  const [orchestratorInfo, setOrchestratorInfo] = useState<OrchestratorDirective | null>(null);
  const [iterationInfo, setIterationInfo] = useState<IterationInfo | null>(null);
  const [simScores, setSimScores] = useState<Record<string, SimSummary>>({});
  const [finalSim, setFinalSim] = useState<SimSummary | null>(null);
  const [sessions, setSessions] = useState<Session[]>(() => {
    try {
      const raw = localStorage.getItem("council-sessions");
      if (!raw) return [];
      const parsed = JSON.parse(raw) as (Omit<Session, "timestamp"> & { timestamp: string })[];
      return parsed.map((s) => ({ ...s, timestamp: new Date(s.timestamp) }));
    } catch { return []; }
  });
  const [view, setView] = useState<"live" | "history" | { sessionId: string }>("live");

  const [panelSize, setPanelSize] = useState({ width: 620, height: 780 });

  const hasStarted = useRef(false);
  const agentStatesRef = useRef<Record<string, AgentState>>({});
  const statusRef = useRef<string[]>([]);
  const proposedRoutesRef = useRef<ProposedRoute[]>([]);
  const spokenQuotesRef = useRef<Set<string>>(new Set());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sessionTimestamp = useRef<Date>(new Date());
  const abortControllerRef = useRef<AbortController | null>(null);
  /** Stable id for one council run — close-out snapshot + SSE `done` both upsert this row. */
  const currentSessionIdRef = useRef("");
  const doneReceivedRef = useRef(false);
  const streamingRef = useRef(false);
  const finalRouteRef = useRef<ParsedRoute | null>(null);
  const routeScoresRef = useRef<Record<string, RouteScore>>({});
  const orchestratorInfoRef = useRef<OrchestratorDirective | null>(null);
  const iterationInfoRef = useRef<IterationInfo | null>(null);

  useEffect(() => { streamingRef.current = streaming; }, [streaming]);
  useEffect(() => { finalRouteRef.current = finalRoute; }, [finalRoute]);
  useEffect(() => { routeScoresRef.current = routeScores; }, [routeScores]);
  useEffect(() => { orchestratorInfoRef.current = orchestratorInfo; }, [orchestratorInfo]);
  useEffect(() => { iterationInfoRef.current = iterationInfo; }, [iterationInfo]);

  function upsertCouncilSession(snapshot: Session) {
    setSessions((prev) => {
      const i = prev.findIndex((s) => s.id === snapshot.id);
      if (i >= 0) {
        const next = [...prev];
        next[i] = snapshot;
        return next;
      }
      return [...prev, snapshot];
    });
  }

  function buildCouncilSnapshot(extras: { incomplete: boolean }): Session {
    const commissionRoute = agentStatesRef.current["Planning Commission"]?.route;
    return {
      id: currentSessionIdRef.current,
      timestamp: sessionTimestamp.current,
      neighbourhoods: neighbourhoodNames,
      stations: stationNames,
      agentStates: { ...agentStatesRef.current },
      statusMessages: [...statusRef.current],
      proposedRoutes: [...proposedRoutesRef.current],
      finalRoute: finalRouteRef.current ?? commissionRoute,
      incomplete: extras.incomplete,
      routeScores: { ...routeScoresRef.current },
      orchestratorInfo: orchestratorInfoRef.current,
      iterationInfo: iterationInfoRef.current,
    };
  }

  function councilSnapshotHasContent(): boolean {
    return (
      Object.keys(agentStatesRef.current).length > 0 ||
      proposedRoutesRef.current.length > 0 ||
      statusRef.current.length > 0 ||
      finalRouteRef.current != null
    );
  }

  /** Persist partial council + stop streaming so closing the panel cannot corrupt refs mid-flight. */
  function handleClosePanel() {
    const runId = currentSessionIdRef.current;
    if (
      hasStarted.current &&
      runId &&
      !doneReceivedRef.current &&
      (streamingRef.current || councilSnapshotHasContent())
    ) {
      upsertCouncilSession(buildCouncilSnapshot({ incomplete: true }));
    }
    onClose();
  }

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = panelSize.width;
    const startH = panelSize.height;
    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(400, Math.min(900, startW - (ev.clientX - startX)));
      const newH = Math.max(320, Math.min(window.innerHeight - 80, startH - (ev.clientY - startY)));
      setPanelSize({ width: newW, height: newH });
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  useEffect(() => { agentStatesRef.current = agentStates; }, [agentStates]);

  useEffect(() => {
    try { localStorage.setItem("council-sessions", JSON.stringify(sessions)); } catch { /* quota exceeded */ }
  }, [sessions]);

  // Scroll outer container to bottom only if user is already near the bottom
  useEffect(() => {
    requestAnimationFrame(() => {
      const el = scrollContainerRef.current;
      if (!el) return;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    });
  }, [agentStates, statusMessages, finalRoute]);

  useEffect(() => {
    if (!open) return;
    if (!startNew) { setView("history"); return; }
    if (hasStarted.current) return;
    hasStarted.current = true;
    sessionTimestamp.current = new Date();
    setView("live");
    void startCouncil();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, startNew]);

  useEffect(() => {
    if (!open) {
      // If the council is still streaming, keep state so reopening brings the user
      // back to the in-progress council (and we already snapshot to history on close).
      if (hasStarted.current && !doneReceivedRef.current) return;
      hasStarted.current = false;
      setAgentStates({});
      agentStatesRef.current = {};
      setStatusMessages([]);
      statusRef.current = [];
      setProposedRoutes([]);
      proposedRoutesRef.current = [];
      spokenQuotesRef.current = new Set();
      setFinalRoute(null);
      setStreaming(false);
      setRouteScores({});
      setOrchestratorInfo(null);
      setIterationInfo(null);
      setSimScores({});
      setFinalSim(null);
      onRoutePreview?.(null);
    }
  }, [open, onRoutePreview]);

  async function startCouncil() {
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const signal = abortControllerRef.current.signal;
    currentSessionIdRef.current = `council-${Date.now()}`;
    doneReceivedRef.current = false;
    finalRouteRef.current = null;
    routeScoresRef.current = {};
    orchestratorInfoRef.current = null;
    iterationInfoRef.current = null;

    setStreaming(true);
    setAgentStates({});
    setStatusMessages([]);
    setProposedRoutes([]);
    setFinalRoute(null);
    setRouteScores({});
    setOrchestratorInfo(null);
    setIterationInfo(null);
    setSimScores({});
    setFinalSim(null);
    agentStatesRef.current = {};
    statusRef.current = [];
    proposedRoutesRef.current = [];
    spokenQuotesRef.current = new Set();

    try {
      const resp = await fetch("/api/council", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          neighbourhoods: neighbourhoodNames,
          stations: stationNames,
          line_type: null,
          context: null,
          existing_lines: existingLineStops,
          provider: localStorage.getItem("aiProvider") ?? "anthropic",
          randomize_speaking_order: randomizeSpeakingOrder,
        }),
        signal,
      });

      if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const parts = buf.split("\n\n");
        buf = parts.pop() ?? "";

        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          try {
            const evt = JSON.parse(payload) as Record<string, unknown>;
            const evtAgent = evt.agent as string | undefined;

            if (evt.type === "status") {
              statusRef.current = [...statusRef.current, evt.text as string];
              setStatusMessages([...statusRef.current]);

            } else if (evt.type === "agent_start" && evtAgent) {
              const newState: AgentState = {
                agent: evtAgent,
                role: evt.role as string,
                color: evt.color as string,
                text: "",
                done: false,
              };
              agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: newState };
              setAgentStates({ ...agentStatesRef.current });

            } else if (evt.type === "agent_text" && evtAgent) {
              const prev = agentStatesRef.current[evtAgent];
              if (prev) {
                const updated = { ...prev, text: prev.text + (evt.text as string) };
                agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: updated };
                setAgentStates({ ...agentStatesRef.current });
              }

            } else if (evt.type === "agent_quote" && evtAgent) {
              const quote = evt.text as string;
              const prev = agentStatesRef.current[evtAgent];
              if (prev) {
                agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: { ...prev, quote } };
                setAgentStates({ ...agentStatesRef.current });
              }
              // Dedup: only speak if this exact quote hasn't been spoken yet
              if (!spokenQuotesRef.current.has(quote)) {
                spokenQuotesRef.current.add(quote);
                if (openRef.current) void speakQuote(evtAgent, quote);
              }

            } else if (evt.type === "agent_end" && evtAgent) {
              const prev = agentStatesRef.current[evtAgent];
              if (prev) {
                const route = extractRoute(prev.text) ?? undefined;
                agentStatesRef.current = { ...agentStatesRef.current, [evtAgent]: { ...prev, done: true, route } };
                setAgentStates({ ...agentStatesRef.current });
              }

            } else if (evt.type === "score_update") {
              const agentName = evt.agent as string;
              setRouteScores((prev) => {
                const next = { ...prev, [agentName]: evt.score as RouteScore };
                routeScoresRef.current = next;
                return next;
              });

            } else if (evt.type === "sim_update") {
              const agentName = evt.agent as string;
              setSimScores((prev) => ({ ...prev, [agentName]: evt.sim as SimSummary }));

            } else if (evt.type === "sim_final") {
              setFinalSim(evt.sim as SimSummary);

            } else if (evt.type === "orchestrator") {
              const directive = evt.directive as OrchestratorDirective;
              orchestratorInfoRef.current = directive;
              setOrchestratorInfo(directive);

            } else if (evt.type === "iteration") {
              const iter = {
                round: evt.round as number,
                converged: evt.converged as boolean,
                reason: evt.reason as string,
              };
              iterationInfoRef.current = iter;
              setIterationInfo(iter);

            } else if (evt.type === "tool_call") {
              onToolCall?.(evt as unknown as ToolCallEvent);

            } else if (evt.type === "route_update") {
              const updatedRoute = evt.route as ParsedRoute;
              const round = evt.round as number | undefined;
              const label = round === 1 ? "Alex's Proposal" : round === 2 ? "Jordan's Revision" : "Compromise";
              // Replace existing entry for same label or append
              const existing = proposedRoutesRef.current.findIndex((r) => r.label === label);
              if (existing >= 0) {
                const color = proposedRoutesRef.current[existing]!.route.color;
                proposedRoutesRef.current = proposedRoutesRef.current.map((r, i) => i === existing ? { label, route: { ...updatedRoute, color } } : r);
              } else {
                const color = routeColor(proposedRoutesRef.current.length);
                proposedRoutesRef.current = [...proposedRoutesRef.current, { label, route: { ...updatedRoute, color } }];
              }
              setProposedRoutes([...proposedRoutesRef.current]);
              onRoutePreview?.(proposedRoutesRef.current.map((p) => p.route));

            } else if (evt.type === "route_final") {
              const route = { ...(evt.route as ParsedRoute), prScore: evt.pr_score as number | undefined };
              finalRouteRef.current = route;
              setFinalRoute(route);
              onRoutePreview?.(null);
              onAddRoute(route);

            } else if (evt.type === "done") {
              setStreaming(false);
              onRoutePreview?.(null);
              doneReceivedRef.current = true;
              upsertCouncilSession(buildCouncilSnapshot({ incomplete: false }));
            }
          } catch {
            // ignore malformed chunk
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStreaming(false);
        onRoutePreview?.(null);
        return;
      }
      setStatusMessages((prev) => [...prev, "Something went wrong. Please try again."]);
      console.error("Council error:", err);
    } finally {
      setStreaming(false);
      onRoutePreview?.(null);
    }
  }

  if (!open) return null;

  const topAgents = AGENT_ORDER.filter((a) => agentStates[a]);
  const commission = agentStates["Planning Commission"];
  const activeAgent = Object.values(agentStates).find((a) => !a.done)?.agent;
  const rightOffset = routePanelOpen ? "376px" : "56px";
  // Keep council panel inside the viewport on short windows / mobile toolbars (# 📖 Learn: dvh tracks dynamic viewport when browser chrome shows/hides).
  const panelEdgeReservePx = routePanelOpen ? 422 : 122;
  const panelLayoutStyle: React.CSSProperties = {
    bottom: "1.25rem",
    right: `calc(${rightOffset} + 30px)`,
    width: `min(${panelSize.width}px, calc(100vw - ${panelEdgeReservePx}px))`,
    height: `min(${panelSize.height}px, calc(100dvh - 5.5rem))`,
    maxHeight: "calc(100dvh - 5.5rem)",
    transition: "right 0.3s ease",
  };

  // ── History list ─────────────────────────────────────────────────────────────
  const resizeHandle = (
    <div
      onMouseDown={startResize}
      className="absolute top-0 left-0 w-4 h-4 cursor-nw-resize z-10 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity"
      title="Drag to resize"
    >
      <svg viewBox="0 0 8 8" className="w-2.5 h-2.5 text-stone-400" fill="currentColor">
        <circle cx="1.5" cy="6.5" r="1"/><circle cx="4" cy="6.5" r="1"/><circle cx="4" cy="4" r="1"/><circle cx="6.5" cy="6.5" r="1"/><circle cx="6.5" cy="4" r="1"/><circle cx="6.5" cy="1.5" r="1"/>
      </svg>
    </div>
  );

  if (view === "history") {
    return (
      <div className={`pointer-events-auto absolute flex min-h-0 flex-col overflow-hidden ${PANEL_CLASSES}`}
        style={panelLayoutStyle}>
        {resizeHandle}
        <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 px-4 py-3">
          <button onClick={() => setView("live")} className="text-stone-400 hover:text-stone-700">
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          </button>
          <p className="text-sm font-semibold text-stone-800">Session History</p>
          <p className="ml-auto text-xs text-stone-400">{sessions.length} session{sessions.length !== 1 ? "s" : ""}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
          {sessions.length === 0 && <p className="text-center text-sm text-stone-400 py-8">No past sessions yet</p>}
          {[...sessions].reverse().map((s) => (
            <button key={s.id} onClick={() => setView({ sessionId: s.id })}
              className="w-full text-left rounded-xl px-3.5 py-2.5 transition-colors hover:brightness-95 bg-stone-50"
              style={{ ...CARD_STYLE, display: "block" }}>
              <div className="flex items-center gap-2 mb-0.5">
                {s.finalRoute && <span className="h-2 w-4 rounded-full shrink-0" style={{ background: s.finalRoute.color }} />}
                <span className="text-xs font-semibold text-stone-700 truncate">
                  {s.finalRoute?.name ?? (s.incomplete ? "Deliberation (draft)" : "No route generated")}
                </span>
                <span className="ml-auto text-[10px] text-stone-400 shrink-0">{fmtTime(s.timestamp)}</span>
                {s.finalRoute && (
                  <button
                    onClick={(e) => { e.stopPropagation(); openFullReport(s.agentStates, s.finalRoute ?? null, s.neighbourhoods, s.stations, s.timestamp); }}
                    className="text-[10px] text-stone-400 hover:text-stone-700 transition-colors shrink-0 ml-1"
                    title="Full report"
                  >
                    <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 1h5.5L10 3.5V11H2V1z"/><path d="M7 1v3h3"/></svg>
                  </button>
                )}
              </div>
              {s.neighbourhoods.length > 0 && <p className="text-[11px] text-stone-400 truncate">{s.neighbourhoods.join(", ")}</p>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  // ── Past session detail ───────────────────────────────────────────────────────
  if (typeof view === "object") {
    const session = sessions.find((s) => s.id === view.sessionId);
    if (!session) { setView("live"); return null; }
    return (
      <div className={`pointer-events-auto absolute flex min-h-0 flex-col overflow-hidden ${PANEL_CLASSES}`}
        style={panelLayoutStyle}>
        {resizeHandle}
        <div className="flex shrink-0 items-center gap-2 border-b border-stone-200 px-4 py-3">
          <button onClick={() => setView("history")} className="text-stone-400 hover:text-stone-700">
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 3L5 8l5 5"/></svg>
          </button>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-stone-800 truncate">
              {session.finalRoute?.name ?? (session.incomplete ? "Deliberation (draft)" : "Council Session")}
            </p>
            <p className="text-xs text-stone-400">{fmtTime(session.timestamp)}</p>
          </div>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {session.finalRoute && (
              <button
                onClick={() => openFullReport(session.agentStates, session.finalRoute ?? null, session.neighbourhoods, session.stations, session.timestamp)}
                className="flex items-center gap-1 text-[11px] font-medium text-stone-500 hover:text-stone-800 transition-colors"
              >
                <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M2 1h5.5L10 3.5V11H2V1z"/><path d="M7 1v3h3"/><path d="M4 6h4M4 8h3"/></svg>
                Full report
              </button>
            )}
            <button type="button" onClick={handleClosePanel} className="text-stone-400 hover:text-stone-600">
              <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 1l10 10M11 1L1 11"/></svg>
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <SessionDetail session={session} />
        </div>
      </div>
    );
  }

  // ── Live view ─────────────────────────────────────────────────────────────────
  return (
    <div className={`pointer-events-auto absolute flex min-h-0 flex-col overflow-hidden ${PANEL_CLASSES}`}
      style={panelLayoutStyle}>
      {resizeHandle}

      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-stone-200 px-4 py-3">
        <div>
          <p className="text-sm font-semibold text-stone-800">Transit Council</p>
          <p className="text-xs text-stone-400">{streaming ? "Deliberation in progress…" : "Deliberation complete"}</p>
          <p className="text-[10px] text-amber-500 font-medium mt-0.5">Experimental feature</p>
        </div>
        <div className="flex items-center gap-2">
          {sessions.length > 0 && (
            <button onClick={() => setView("history")}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-stone-500 hover:bg-stone-100 transition-all bg-stone-50"
              style={CARD_STYLE}>
              <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2"/>
              </svg>
              {sessions.length}
            </button>
          )}
          <button type="button" onClick={handleClosePanel} className="text-stone-400 hover:text-stone-600">
            <svg viewBox="0 0 12 12" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M1 1l10 10M11 1L1 11"/></svg>
          </button>
        </div>
      </div>

      {/* Requirements chips */}
      {(neighbourhoodNames.length > 0 || stationNames.length > 0) && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-stone-200 px-4 py-2">
          {neighbourhoodNames.map((n) => <span key={n} className="rounded-full bg-stone-100 px-3 py-0.5 text-[11px] font-medium text-stone-600 border border-stone-200">{n}</span>)}
          {stationNames.map((s) => <span key={s} className="rounded-full bg-stone-100 border border-stone-200 px-3 py-0.5 text-[11px] font-medium text-stone-500">{s}</span>)}
        </div>
      )}

      {/* Status — latest only */}
      {statusMessages.length > 0 && (
        <div className="px-4 pt-2 shrink-0">
          <p className="text-center text-[11px] text-stone-400 italic">{statusMessages[statusMessages.length - 1]}</p>
        </div>
      )}

      {/* Scrollable content */}
      <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">

        {/* Agent list — vertical */}
        {topAgents.length > 0 && (
          <div className="px-4 pt-3">
            {topAgents.map((name) => (
              <AgentCard key={name} state={agentStates[name]!} isActive={activeAgent === name} />
            ))}
          </div>
        )}

        {/* Assembling placeholder */}
        {topAgents.length === 0 && streaming && (
          <div className="flex items-center gap-2 px-4 py-6 justify-center">
            <span className="flex gap-0.5">
              {[0, 1, 2].map((d) => (
                <span key={d} className="h-1.5 w-1.5 rounded-full bg-stone-300 animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />
              ))}
            </span>
            <span className="text-[11px] text-stone-400">Assembling council…</span>
          </div>
        )}

        {/* Commission pulse indicator */}
        {streaming && !finalRoute && topAgents.length > 0 && topAgents.every((n) => agentStates[n]?.done) && (
          <div className="px-4 pt-3 pb-1">
            <div className="flex items-center gap-2">
              <span className="flex gap-0.5">
                {[0, 1, 2].map((d) => (
                  <span key={d} className="h-1 w-1 rounded-full bg-stone-400 animate-bounce" style={{ animationDelay: `${d * 0.15}s` }} />
                ))}
              </span>
              <span className="text-[11px] text-stone-400 italic">
                {commission && !commission.done ? "Generating documentation…" : "Planning Commission deliberating…"}
              </span>
            </div>
          </div>
        )}

        {/* Commission agent card */}
        {commission && (
          <div className="px-4">
            <AgentCard state={commission} isActive={activeAgent === "Planning Commission"} />
          </div>
        )}

        {/* Route score cards */}
        {Object.keys(routeScores).length > 0 && (
          <div className="px-4 pt-2 pb-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">Route Scores</p>
            <div className="flex gap-2">
              {Object.entries(routeScores).map(([agent, score]) => {
                const agentColor = AGENTS_META[agent] ?? "#64748b";
                return <RouteScoreCard key={agent} agent={agent} score={score} color={agentColor} />;
              })}
            </div>
            {Object.keys(simScores).length > 0 && (
              <div className="flex gap-2 mt-1.5">
                {Object.entries(simScores).map(([agent, sim]) => {
                  const agentColor = AGENTS_META[agent] ?? "#64748b";
                  return <SimScoreCard key={agent} agent={agent} sim={sim} color={agentColor} />;
                })}
              </div>
            )}
          </div>
        )}

        {/* Orchestrator directive */}
        {orchestratorInfo && (
          <OrchestratorBadge directive={orchestratorInfo} iterationInfo={iterationInfo} />
        )}

        {/* Proposed routes */}
        {proposedRoutes.length > 0 && (
          <div className="px-4 pt-1 pb-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 mb-1.5">Proposals</p>
            <div className="flex gap-2 flex-wrap">
              {proposedRoutes.map(({ label, route }) => {
                const isFinal = finalRoute && route.name === finalRoute.name && route.color === finalRoute.color;
                return (
                  <div key={label} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px]"
                    style={{ ...CARD_STYLE, opacity: finalRoute && !isFinal ? 0.5 : 1, outline: isFinal ? "1.5px solid #1c1917" : "none" }}>
                    <span className="h-1.5 w-3 rounded-full shrink-0" style={{ background: route.color }} />
                    <span className="font-medium text-stone-700">{route.name}</span>
                    <span className="text-stone-400">·</span>
                    <span className="text-stone-400">{label}</span>
                    {isFinal && <span className="text-[10px] font-semibold text-stone-600 ml-0.5">✓</span>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Final recommendation */}
        {finalRoute && (
          <div className="mt-2.5">
            <FinalRecommendationCard
              route={finalRoute}
              commissionQuote={commission?.quote}
              agentStates={agentStates}
              neighbourhoods={neighbourhoodNames}
              stations={stationNames}
              timestamp={sessionTimestamp.current}
              simSummary={finalSim}
            />
          </div>
        )}

        <div className="h-2" />
      </div>
    </div>
  );
}
