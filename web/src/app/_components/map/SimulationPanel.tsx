"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import type { Route } from "~/app/map/transit-data";

// ── Types ─────────────────────────────────────────────────────────────────────

type IncomeBreakdown = Record<string, number>;

interface TransitSpeedData {
  speeds: Record<string, number>;
  boardingPenalties: Record<string, number>;
  liveHeadways: Record<string, number | null>;
  routeCounts: Record<string, number>;
  roadMultiplier: number;
  timePeriod: string;
  isLive: boolean;
  source: "live" | "fallback";
  updatedAt: number;
  tripCount: number;
}

interface RunStats {
  pct_accessible: number;
  avg_transit_time_min: number;
  median_transit_time_min: number;
  p90_transit_time_min: number;
  avg_total_time_min: number;
  avg_transfers: number;
  avg_car_time_min: number;
  income_breakdown: IncomeBreakdown;
}

interface DeltaStats {
  time_saved_min: number;
  total_time_saved_min: number;
  accessibility_gain_pct: number;
  transfer_reduction: number;
  equity_improvement: number;
  newly_accessible_agents: number;
}

interface EquityStats {
  baseline_score: number;
  scenario_score: number;
}

export interface StressSegment {
  line_name?: string;
  from_stop: string;
  to_stop: string;
  from_coords: [number, number];
  to_coords: [number, number];
  agent_trips: number;
  baseline_trips: number;
  stress_pct: number;
  delta_pct: number;
  edge_pk?: number;
}

export interface PerAgentResult {
  agent_id: number;
  home_lon: number;
  home_lat: number;
  income: string;
  transit_dep: number;
  persona: string;
  purpose: string;
  baseline_time: number;
  scenario_time: number;
  time_saved_min: number;
  newly_accessible: boolean;
  departure_min: number;
  path_coords: [number, number][];
}

export interface SimulationResult {
  scenario_name: string;
  agent_count: number;
  animated_agent_count: number;
  run_duration_s: number;
  has_proposed_lines: boolean;
  time_range: { start_min: number; end_min: number };
  baseline: RunStats;
  scenario: RunStats;
  delta: DeltaStats;
  equity: EquityStats;
  line_stress: StressSegment[];
  baseline_edge_stress: StressSegment[];
  per_agent: PerAgentResult[];
  narrative: string;
  graph_stats: {
    baseline_nodes: number;
    baseline_edges: number;
    scenario_nodes: number;
    scenario_edges: number;
  };
  transit_speed_source?:    "live" | "fallback";
  transit_updated_at?:      number | null;
  transit_trip_count?:      number;
  transit_road_multiplier?: number;
  transit_time_period?:     string;
}

export interface SimulationPanelProps {
  customRoutes: Route[];
  onClose: () => void;
  onResults: (result: SimulationResult | null) => void;
  onAnimate: (agents: PerAgentResult[]) => void;
  /** Optional callback for the per-segment "Ask AI" affordance on the Stress tab. */
  onAskAI?: (segment: StressSegment) => void;
  /**
   * A result computed somewhere else — the Ask AI assistant's run_simulation
   * tool. Whenever this changes to a new non-null result, the panel shows it
   * (Overview tab) exactly as if the user had pressed Run. It is NOT re-run.
   * The parent has already put it on the map, so onResults isn't called for it.
   */
  externalResult?: SimulationResult | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const MIN_TIME = 360;   // 6:00am
const MAX_TIME = 1440;  // midnight
const STEP     = 30;    // 30-min steps

function fmtMin(m: number): string {
  const h = Math.floor(m / 60) % 24;
  const mm = m % 60;
  const period = h < 12 ? "am" : "pm";
  const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return mm === 0 ? `${display}${period}` : `${display}:${String(mm).padStart(2, "0")}${period}`;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatRow({
  label,
  baseline,
  scenario,
  unit = "",
  better = "lower",
  hideScenario = false,
}: {
  label: string;
  baseline: number | string;
  scenario: number | string;
  unit?: string;
  better?: "lower" | "higher";
  hideScenario?: boolean;
}) {
  const bNum = typeof baseline === "number" ? baseline : parseFloat(baseline as string);
  const sNum = typeof scenario === "number" ? scenario : parseFloat(scenario as string);
  const improved = better === "lower" ? sNum < bNum : sNum > bNum;
  const delta = !hideScenario && typeof bNum === "number" && typeof sNum === "number" ? sNum - bNum : null;

  return (
    <div className="flex items-center justify-between py-1.5 border-b border-stone-100 last:border-0">
      <span className="text-xs text-stone-500 w-36 shrink-0">{label}</span>
      <div className="flex items-center gap-3 text-xs font-mono">
        <span className={`${hideScenario ? "text-stone-700 font-semibold" : "text-stone-400"} w-14 text-right`}>
          {typeof baseline === "number" ? baseline.toFixed(1) : baseline}
          {unit}
        </span>
        {!hideScenario && (
          <>
            <span className="text-stone-300">→</span>
            <span
              className={`w-14 text-right font-semibold ${
                delta !== null && Math.abs(delta) > 0.05
                  ? improved
                    ? "text-emerald-600"
                    : "text-red-500"
                  : "text-stone-600"
              }`}
            >
              {typeof scenario === "number" ? scenario.toFixed(1) : scenario}
              {unit}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function ScoreBadge({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.min(100, value);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex justify-between text-xs">
        <span className="text-stone-500">{label}</span>
        <span className="font-semibold text-stone-700">{value.toFixed(0)}/100</span>
      </div>
      <div className="h-1.5 rounded-full bg-stone-100">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
}

function StressBar({ segment, isProposed, onAskAI }: { segment: StressSegment; isProposed: boolean; onAskAI?: (segment: StressSegment) => void }) {
  // Both proposed and existing use green/amber/red on the same global scale.
  // Existing lines are further colored by delta; proposed lines by absolute stress_pct.
  const loadColor = segment.stress_pct > 66 ? "#ef4444"
    : segment.stress_pct > 33 ? "#f59e0b"
    : "#10b981";

  // Delta badge for existing lines
  const delta = segment.baseline_trips - segment.agent_trips;
  const deltaLabel =
    isProposed ? null
    : delta > 2  ? `▼ ${delta}`
    : delta < -2 ? `▲ ${Math.abs(delta)}`
    : null;
  const deltaColor = delta > 2 ? "#10b981" : "#ef4444";

  // 📖 Learn: only surface the "Ask AI" affordance for genuinely problematic
  // segments. < 50% stress isn't a hotspot; cluttering every row with the
  // button would dilute the signal.
  const isHotspot = segment.stress_pct >= 50 || segment.delta_pct >= 25;

  return (
    <div className="group flex items-center gap-2 py-1">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-xs text-stone-700 font-medium">
            {segment.from_stop} → {segment.to_stop}
          </p>
          {isProposed && (
            <span className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-indigo-600 bg-indigo-50 border border-indigo-200 rounded px-1 py-px">
              new
            </span>
          )}
        </div>
        <p className="text-[10px] text-stone-400">
          {segment.agent_trips} trips
          {!isProposed && segment.baseline_trips > 0 && ` · was ${segment.baseline_trips}`}
          {segment.line_name ? ` · ${segment.line_name}` : ""}
        </p>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {onAskAI && isHotspot && (
          <button
            onClick={() => onAskAI(segment)}
            title="Ask AI about this segment"
            aria-label="Ask AI about this segment"
            className="flex h-5 w-5 items-center justify-center rounded text-stone-300 opacity-0 transition-opacity hover:bg-indigo-50 hover:text-indigo-600 group-hover:opacity-100"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3 w-3">
              <path d="M8 1.5L9.5 6L14 7.5L9.5 9L8 13.5L6.5 9L2 7.5L6.5 6Z" />
            </svg>
          </button>
        )}
        {deltaLabel && (
          <span className="text-[10px] font-semibold w-10 text-right" style={{ color: deltaColor }}>
            {deltaLabel}
          </span>
        )}
        <div className="w-16 h-1.5 rounded-full bg-stone-100">
          <div className="h-full rounded-full" style={{ width: `${segment.stress_pct}%`, backgroundColor: loadColor }} />
        </div>
        <span className="text-[10px] font-mono text-stone-500 w-8 text-right">
          {segment.stress_pct.toFixed(0)}%
        </span>
      </div>
    </div>
  );
}

// Dual-handle range slider
function TimeRangeSlider({
  startMin, endMin,
  onStartChange, onEndChange,
}: {
  startMin: number; endMin: number;
  onStartChange: (v: number) => void;
  onEndChange:   (v: number) => void;
}) {
  const range = MAX_TIME - MIN_TIME;
  const leftPct  = ((startMin - MIN_TIME) / range) * 100;
  const rightPct = ((endMin   - MIN_TIME) / range) * 100;

  return (
    <div className="space-y-2">
      {/* CSS to allow both thumbs to receive pointer events independently */}
      <style>{`
        .time-range-input {
          pointer-events: none;
        }
        .time-range-input::-webkit-slider-thumb {
          pointer-events: all;
          cursor: grab;
        }
        .time-range-input::-moz-range-thumb {
          pointer-events: all;
          cursor: grab;
        }
        .time-range-input:active::-webkit-slider-thumb { cursor: grabbing; }
        .time-range-input:active::-moz-range-thumb { cursor: grabbing; }
      `}</style>

      <div className="flex justify-between text-xs font-medium text-stone-700">
        <span>{fmtMin(startMin)}</span>
        <span>{fmtMin(endMin)}</span>
      </div>

      {/* Track */}
      <div className="relative h-5 flex items-center">
        <div className="absolute inset-x-0 h-1.5 rounded-full bg-stone-200" />
        {/* Highlighted range */}
        <div
          className="absolute h-1.5 rounded-full bg-indigo-500"
          style={{ left: `${leftPct}%`, right: `${100 - rightPct}%` }}
        />
        {/* Start handle */}
        <input
          type="range"
          min={MIN_TIME} max={MAX_TIME - STEP} step={STEP}
          value={startMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v < endMin) onStartChange(v);
          }}
          className="time-range-input absolute inset-0 w-full appearance-none bg-transparent"
          style={{ zIndex: 3 }}
        />
        {/* End handle */}
        <input
          type="range"
          min={MIN_TIME + STEP} max={MAX_TIME} step={STEP}
          value={endMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (v > startMin) onEndChange(v);
          }}
          className="time-range-input absolute inset-0 w-full appearance-none bg-transparent"
          style={{ zIndex: 3 }}
        />
      </div>

      {/* Tick labels */}
      <div className="flex justify-between text-[9px] text-stone-400">
        <span>6am</span>
        <span>9am</span>
        <span>12pm</span>
        <span>3pm</span>
        <span>6pm</span>
        <span>9pm</span>
        <span>12am</span>
      </div>
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function SimulationPanel({ customRoutes, onClose, onResults, onAnimate, onAskAI, externalResult }: SimulationPanelProps) {
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const [result, setResult]           = useState<SimulationResult | null>(null);
  const [agentCount, setAgentCount]   = useState(500);
  const [startMin, setStartMin]       = useState(360);   // 6:00am
  const [endMin, setEndMin]           = useState(1440);  // midnight
  const [activeTab, setActiveTab]     = useState<"overview" | "equity" | "stress" | "narrative">("overview");
  const [speedsFetching, setSpeedsFetching] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Adopt a result the assistant ran. Keyed on the object itself: every
  // show_simulation event carries a freshly parsed object, so a second run
  // is a new value even if the numbers happen to match. A null (no assistant
  // run yet) leaves whatever the user is looking at alone.
  useEffect(() => {
    if (!externalResult) return;
    setResult(externalResult);
    setError(null);
    setActiveTab("overview");
  }, [externalResult]);

  const hasProposed = customRoutes.length > 0;
  const scenarioName = hasProposed
    ? (customRoutes.length === 1 ? (customRoutes[0]?.name ?? "Proposed Line") : `${customRoutes.length} Custom Lines`)
    : "Baseline Network";

  const runSimulation = useCallback(async () => {
    setLoading(true);
    setError(null);

    const proposedLines = customRoutes.map((r) => ({
      name: r.name,
      type: r.type,
      stops: r.stops.map((s) => ({ name: s.name, coords: s.coords })),
    }));

    // Pre-fetch live TTC speeds; fail silently and fall back to defaults
    let speeds: TransitSpeedData | null = null;
    try {
      setSpeedsFetching(true);
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 3000);
      const r    = await fetch(
        `/api/transit-speeds?start_min=${startMin}&end_min=${endMin}`,
        { signal: ctrl.signal },
      );
      clearTimeout(tid);
      if (r.ok) speeds = (await r.json()) as TransitSpeedData;
    } catch (err) {
      // AbortError is expected on timeout — suppress; log anything unexpected
      if (err instanceof Error && err.name !== "AbortError") {
        console.warn("[transit-speeds] pre-fetch failed:", err.message);
      }
    } finally {
      if (mountedRef.current) setSpeedsFetching(false);
    }

    try {
      const res = await fetch("/api/simulation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          proposed_lines: proposedLines,
          agent_count: agentCount,
          scenario_name: scenarioName,
          narrate: hasProposed,
          time_range: { start_min: startMin, end_min: endMin },
          transit_speeds: speeds ?? undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { detail?: string }).detail ?? `HTTP ${res.status}`);
      }

      const data = (await res.json()) as SimulationResult;
      setResult(data);
      onResults(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Simulation failed");
      onResults(null);
    } finally {
      setLoading(false);
    }
  }, [customRoutes, agentCount, scenarioName, hasProposed, startMin, endMin, onResults]);

  const handleClose = () => { onResults(null); onClose(); };

  type TabId = "overview" | "equity" | "stress" | "narrative";
  const tabs: { id: TabId; label: string }[] = [
    { id: "overview",  label: "Overview" },
    { id: "equity",    label: "Equity" },
    { id: "stress",    label: "Stress" },
    ...(result?.has_proposed_lines ? [{ id: "narrative" as TabId, label: "Analysis" }] : []),
  ];

  return (
    <div className="pointer-events-auto flex flex-col w-[320px] rounded-2xl border border-[#D7D7D7] bg-white shadow-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-stone-100">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 6v6l4 2" />
            </svg>
          </div>
          <span className="text-sm font-semibold text-stone-800">Agent Simulation</span>
        </div>
        <button onClick={handleClose} className="text-stone-400 hover:text-stone-600 transition-colors">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Config */}
      {!result && (
        <div className="px-4 py-3 border-b border-stone-100 bg-stone-50 space-y-3">
          <div>
            <p className="text-xs font-medium text-stone-600 mb-1">
              {hasProposed ? "Comparing against proposed lines" : "Simulating existing network"}
            </p>
            {hasProposed ? (
              <ul className="space-y-0.5">
                {customRoutes.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-xs text-stone-600">
                    <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: r.color }} />
                    {r.name} ({r.stops.length} stops)
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-stone-400">
                Shows stress on current TTC network. Draw custom lines to compare scenarios.
              </p>
            )}
          </div>

          {/* Time range slider */}
          <div>
            <p className="text-xs font-medium text-stone-600 mb-2">Simulate time range</p>
            <TimeRangeSlider
              startMin={startMin} endMin={endMin}
              onStartChange={setStartMin} onEndChange={setEndMin}
            />
          </div>

          {/* Agent count slider */}
          <div>
            <label className="text-xs font-medium text-stone-600">
              Agents: <span className="text-stone-800 font-semibold">{agentCount.toLocaleString()}</span>
            </label>
            <input
              type="range"
              min={500} max={10_000} step={500}
              value={agentCount}
              onChange={(e) => setAgentCount(Number(e.target.value))}
              className="mt-1 w-full accent-indigo-600"
            />
            <div className="flex justify-between text-[10px] text-stone-400">
              <span>500 (fast)</span>
              <span>10,000 (thorough)</span>
            </div>
            <p className="text-[10px] text-stone-400 mt-0.5">Animation shows up to 500 agents; all agents count toward stats.</p>
          </div>

          <button
            onClick={runSimulation}
            disabled={loading}
            className={`w-full rounded-xl py-2 text-sm font-medium transition-all ${
              loading
                ? "bg-stone-100 text-stone-400 cursor-not-allowed"
                : "bg-indigo-600 text-white hover:bg-indigo-700 active:scale-[0.98]"
            }`}
          >
            {loading ? "Running simulation…" : hasProposed ? "Run Scenario Comparison" : "Run Baseline Simulation"}
          </button>

          {loading && (
            <div className="space-y-1">
              <p className="text-xs text-stone-500">
                {speedsFetching
                  ? "Fetching live TTC data…"
                  : `Building transit graph + routing ${agentCount.toLocaleString()} agents…`}
              </p>
              <div className="h-1 rounded-full bg-stone-100 overflow-hidden">
                <div
                  className="h-full bg-indigo-400 rounded-full transition-all duration-700"
                  style={{ width: speedsFetching ? "20%" : "70%", animation: "pulse 1.5s ease-in-out infinite" }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {result && (
        <>
          <div className="flex border-b border-stone-100 bg-stone-50 text-xs font-medium">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 py-2 transition-colors ${
                  activeTab === tab.id
                    ? "border-b-2 border-indigo-600 text-indigo-700 bg-white"
                    : "text-stone-500 hover:text-stone-700"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 max-h-[calc(100vh-260px)]">

            {activeTab === "overview" && (
              <div className="space-y-3">
                {result.has_proposed_lines && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-3 text-center">
                      <p className="text-[10px] text-emerald-600 uppercase tracking-wide mb-0.5">Time saved</p>
                      <p className="text-2xl font-bold text-emerald-700">
                        {result.delta.total_time_saved_min > 0 ? result.delta.total_time_saved_min.toFixed(1) : "–"}
                      </p>
                      <p className="text-[10px] text-emerald-500">min avg</p>
                    </div>
                    <div className="rounded-xl bg-indigo-50 border border-indigo-100 p-3 text-center">
                      <p className="text-[10px] text-indigo-600 uppercase tracking-wide mb-0.5">Newly reached</p>
                      <p className="text-2xl font-bold text-indigo-700">{result.delta.newly_accessible_agents}</p>
                      <p className="text-[10px] text-indigo-500">agents</p>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-stone-100 px-3 py-2">
                  <StatRow label="Transit accessible" baseline={result.baseline.pct_accessible} scenario={result.scenario.pct_accessible} unit="%" better="higher" hideScenario={!result.has_proposed_lines} />
                  <StatRow label="Avg transit time"   baseline={result.baseline.avg_transit_time_min} scenario={result.scenario.avg_transit_time_min} unit=" min" better="lower" hideScenario={!result.has_proposed_lines} />
                  <StatRow label="Avg door-to-door"   baseline={result.baseline.avg_total_time_min} scenario={result.scenario.avg_total_time_min} unit=" min" better="lower" hideScenario={!result.has_proposed_lines} />
                  <StatRow label="P90 transit time"   baseline={result.baseline.p90_transit_time_min} scenario={result.scenario.p90_transit_time_min} unit=" min" better="lower" hideScenario={!result.has_proposed_lines} />
                  <StatRow label="Avg transfers"      baseline={result.baseline.avg_transfers} scenario={result.scenario.avg_transfers} better="lower" hideScenario={!result.has_proposed_lines} />
                </div>

                {/* Time range badge */}
                <p className="text-[10px] text-stone-400 text-center">
                  {fmtMin(result.time_range.start_min)}–{fmtMin(result.time_range.end_min)} · {result.per_agent.length.toLocaleString()} legs · {result.animated_agent_count.toLocaleString()} animated / {result.agent_count.toLocaleString()} agents · {result.run_duration_s}s
                </p>

                {/* Live speed data indicator */}
                {result.transit_speed_source && (
                  <div className="flex items-center gap-1.5 text-[10px] justify-center">
                    <span className="relative flex h-1.5 w-1.5">
                      {result.transit_speed_source === "live" && (
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                      )}
                      <span
                        className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                          result.transit_speed_source === "live" ? "bg-emerald-500" : "bg-stone-300"
                        }`}
                      />
                    </span>
                    <span className="text-stone-400">
                      {result.transit_speed_source === "live" && result.transit_updated_at != null
                        ? [
                            `Live TTC · ${result.transit_time_period ?? ""}`,
                            `${result.transit_trip_count ?? 0} trips`,
                            result.transit_road_multiplier != null && result.transit_road_multiplier !== 1.0
                              ? `road ${Math.round(result.transit_road_multiplier * 100)}% speed`
                              : null,
                            new Date(result.transit_updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
                          ].filter(Boolean).join(" · ")
                        : "Default speeds (live fetch unavailable)"}
                    </span>
                  </div>
                )}

                <button
                  onClick={() => onAnimate(result.per_agent.filter((p) => p.path_coords.length > 0))}
                  className="w-full rounded-xl py-2 text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700 active:scale-[0.98] transition-all"
                >
                  Animate agents on map
                </button>

                <button
                  onClick={() => { setResult(null); onResults(null); }}
                  className="w-full text-xs text-stone-400 hover:text-stone-600 underline"
                >
                  Change settings and re-run
                </button>
              </div>
            )}

            {activeTab === "equity" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <ScoreBadge label={result.has_proposed_lines ? "Baseline equity score" : "Equity score"} value={result.equity.baseline_score} color={result.has_proposed_lines ? "#94a3b8" : "#6366f1"} />
                  {result.has_proposed_lines && (
                    <ScoreBadge label="Scenario equity score" value={result.equity.scenario_score} color="#6366f1" />
                  )}
                </div>

                <div className="rounded-xl border border-stone-100 px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400 mb-2">
                    Avg door-to-door by income
                  </p>
                  {(["low", "mid", "high"] as const).map((inc) => {
                    const b = result.baseline.income_breakdown[inc];
                    const s = result.scenario.income_breakdown[inc];
                    if (!b) return null;
                    return (
                      <StatRow key={inc} label={`${inc.charAt(0).toUpperCase() + inc.slice(1)}-income`} baseline={b} scenario={s ?? b} unit=" min" better="lower" hideScenario={!result.has_proposed_lines} />
                    );
                  })}
                </div>

                <div className="rounded-xl bg-indigo-50 border border-indigo-100 px-3 py-2 text-xs text-indigo-700">
                  <p className="font-semibold mb-0.5">Equity score methodology</p>
                  <p className="text-indigo-600 leading-relaxed">
                    Time savings weighted by transit dependency and income bracket.
                    Low-income agents have 1.5× weight; high-income 0.5×. Normalised to 100.
                  </p>
                </div>
              </div>
            )}

            {activeTab === "stress" && (() => {
              // Merge proposed + existing into one list, sorted by stress_pct descending
              const allSegs = [
                ...result.line_stress.map((s) => ({ seg: s, isProposed: true })),
                ...result.baseline_edge_stress.map((s) => ({ seg: s, isProposed: false })),
              ].sort((a, b) => b.seg.stress_pct - a.seg.stress_pct);

              return (
                <div className="space-y-3">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400 mb-1">
                      Network load — all segments, shared scale
                    </p>
                    {allSegs.length === 0 ? (
                      <p className="text-xs text-stone-400 py-2 text-center">No stress data.</p>
                    ) : (
                      <div className="rounded-xl border border-stone-100 px-3 py-1 divide-y divide-stone-50 max-h-72 overflow-y-auto">
                        {allSegs.map(({ seg, isProposed }, i) => (
                          <StressBar key={i} segment={seg} isProposed={isProposed} onAskAI={onAskAI} />
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[10px] text-stone-400">
                    <p className="w-full font-semibold uppercase tracking-wide text-stone-300 mb-0.5">All lines — same global scale</p>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-500" /> Low load</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-400" /> Medium</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" /> High load</span>
                    {result.has_proposed_lines && (
                      <>
                        <p className="w-full text-stone-300 mt-0.5">New lines shown dashed. Width = absolute load vs system max.</p>
                        <span className="flex items-center gap-1 text-emerald-600">▼ = trips relieved from existing line</span>
                        <span className="flex items-center gap-1 text-red-500">▲ = more loaded than baseline</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })()}

            {activeTab === "narrative" && result.has_proposed_lines && (
              <div className="space-y-3">
                {result.narrative ? (
                  <div className="text-xs text-stone-600 leading-relaxed whitespace-pre-line">{result.narrative}</div>
                ) : (
                  <p className="text-xs text-stone-400 text-center py-4">No narrative generated.</p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
