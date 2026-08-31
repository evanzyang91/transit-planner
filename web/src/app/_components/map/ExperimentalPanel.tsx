// IDEAS TO IMPLEMENT NEXT (experimental):
// - Demographic overlay (age, income, car ownership from StatsCan open data)
// - GTFS-RT live vehicle positions (poll /gotransit/realtime, render moving dots)
// - Station 3D viz with AI-generated streetview renders
// - Property acquisition cost estimator (MPAC / land value lookup)
// - Noise contour modeling (Lden dB rings based on speed, frequency, track type)
// - Interoperability scoring (how well new lines connect to existing hubs)
// - CO2 modal-shift calculator (cars replaced × avg trip CO2)
// - Headway optimisation suggestions per corridor (gravity model + demand data)
// - Real-time construction cost tracker (BCI index inflation adjustment)
// - Comparative city benchmarking (riders/km vs NYC, London, Tokyo)

"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import type { Route } from "~/app/map/transit-data";
import { TransitAssistant } from "./TransitAssistant";
import { haversineKm } from "~/app/map/geo-utils";
import { POPULATION_CENTERS } from "~/app/map/population-centers";
// Shared with the server AI tools — one formula, one source of truth (see
// lib/ridership-model.ts and lib/network-stats.ts for the "why").
import { parseHeadway, forecastRouteRidership } from "~/lib/ridership-model";
import { routeLengthKm } from "~/lib/network-stats";

// ── Scoring ───────────────────────────────────────────────────────────────────

interface ScoreCard {
  frequency: number;
  coverage: number;
  connectivity: number;
  efficiency: number;
  overall: number;
  grade: "A" | "B" | "C" | "D" | "F";
}

function scoreRoute(route: Route, allRoutes: Route[]): ScoreCard {
  const headway = parseHeadway(route.frequency, route.servicePattern);
  const frequency = Math.max(0, Math.min(100, Math.round(100 - headway * 2)));
  const stopCount = route.stops.length;
  const coverage = Math.min(100, stopCount * 3);
  const otherStops = allRoutes
    .filter((r) => r.id !== route.id && r.stops.length > 0)
    .flatMap((r) => r.stops.map((s) => s.coords));
  const connectedCount = route.stops.filter((s) =>
    otherStops.some((os) => haversineKm(s.coords, os) < 0.5),
  ).length;
  const connectivity = stopCount > 0 ? Math.min(100, Math.round((connectedCount / stopCount) * 100)) : 0;
  let totalPath = 0;
  for (let i = 1; i < route.stops.length; i++) totalPath += haversineKm(route.stops[i - 1]!.coords, route.stops[i]!.coords);
  const straightLine = route.stops.length >= 2 ? haversineKm(route.stops[0]!.coords, route.stops[route.stops.length - 1]!.coords) : 0;
  const efficiency = totalPath > 0 ? Math.min(100, Math.round((straightLine / totalPath) * 150)) : 50;
  const overall = Math.round((frequency + coverage + connectivity + efficiency) / 4);
  const grade = overall >= 90 ? "A" : overall >= 75 ? "B" : overall >= 60 ? "C" : overall >= 45 ? "D" : "F";
  return { frequency, coverage, connectivity, efficiency, overall, grade };
}

// ── Cities coverage ───────────────────────────────────────────────────────────

function computeCityCoverage(routes: Route[]) {
  const served = new Set<string>();
  for (const route of routes) {
    for (const stop of route.stops) {
      for (const center of POPULATION_CENTERS) {
        if (!served.has(center.id) && haversineKm(stop.coords, [center.lng, center.lat]) <= center.serviceRadiusKm)
          served.add(center.id);
      }
    }
  }
  const all = POPULATION_CENTERS.map((c) => ({ ...c, isServed: served.has(c.id) })).sort((a, b) => b.population - a.population);
  const totalPop = POPULATION_CENTERS.reduce((s, c) => s + c.population, 0);
  const servedPop = all.filter((c) => c.isServed).reduce((s, c) => s + c.population, 0);
  return {
    all, served: all.filter((c) => c.isServed).slice(0, 5), gaps: all.filter((c) => !c.isServed).slice(0, 5),
    citiesServed: served.size, totalCities: POPULATION_CENTERS.length, servedPop, totalPop,
    pct: totalPop > 0 ? Math.round((servedPop / totalPop) * 1000) / 10 : 0,
  };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

interface Warning { routeName: string; message: string; severity: "warn" | "info" }
interface TransferHub { name: string; routeCount: number; routeNames: string[] }
interface Corridor { label: string; routeCount: number }

function buildDiagnostics(routes: Route[]) {
  const warnings: Warning[] = [];
  for (const r of routes) {
    if (r.stops.length === 0) { warnings.push({ routeName: r.name, message: "No stops added yet.", severity: "info" }); continue; }
    if (r.stops.length === 1) warnings.push({ routeName: r.name, message: "Only 1 stop — needs at least 2.", severity: "warn" });
    const hw = parseHeadway(r.frequency, r.servicePattern);
    if (hw > 20) warnings.push({ routeName: r.name, message: `Headway ${hw} min — consider more frequent service.`, severity: "warn" });
    const km = routeLengthKm(r);
    if (r.stops.length >= 2 && km < 0.3) warnings.push({ routeName: r.name, message: "Route is very short (< 300 m).", severity: "info" });
  }
  const hubMap = new Map<string, { routeIds: Set<string>; names: Set<string> }>();
  for (const route of routes) {
    for (const stop of route.stops) {
      const key = stop.name.toUpperCase().replace(/\s+/g, " ").trim();
      if (!key) continue;
      const existing = hubMap.get(key) ?? { routeIds: new Set(), names: new Set() };
      existing.routeIds.add(route.id); existing.names.add(route.name);
      hubMap.set(key, existing);
    }
  }
  const allStopsWithRoute = routes.flatMap((r) => r.stops.map((s) => ({ coords: s.coords, routeId: r.id, routeName: r.name, name: s.name })));
  const proxMap = new Map<string, { routeIds: Set<string>; names: Set<string> }>();
  for (let i = 0; i < allStopsWithRoute.length; i++) {
    const a = allStopsWithRoute[i]!;
    for (let j = i + 1; j < allStopsWithRoute.length; j++) {
      const b = allStopsWithRoute[j]!;
      if (a.routeId === b.routeId) continue;
      if (haversineKm(a.coords, b.coords) < 0.15) {
        const key = a.name || `${a.coords[0].toFixed(3)},${a.coords[1].toFixed(3)}`;
        const entry = proxMap.get(key) ?? { routeIds: new Set(), names: new Set() };
        entry.routeIds.add(a.routeId); entry.routeIds.add(b.routeId); entry.names.add(a.routeName); entry.names.add(b.routeName);
        proxMap.set(key, entry);
      }
    }
  }
  const hubs: TransferHub[] = [
    ...Array.from(hubMap.entries()).filter(([, v]) => v.routeIds.size >= 2).map(([name, v]) => ({ name, routeCount: v.routeIds.size, routeNames: Array.from(v.names) })),
    ...Array.from(proxMap.entries()).filter(([, v]) => v.routeIds.size >= 2).map(([name, v]) => ({ name, routeCount: v.routeIds.size, routeNames: Array.from(v.names) })),
  ].filter((h, i, arr) => arr.findIndex((x) => x.name === h.name) === i).sort((a, b) => b.routeCount - a.routeCount).slice(0, 5);
  const corridorMap = new Map<string, Set<string>>();
  for (const route of routes) {
    for (let i = 0; i < route.stops.length - 1; i++) {
      const from = route.stops[i]!.name.toUpperCase().trim(), to = route.stops[i + 1]!.name.toUpperCase().trim();
      if (!from || !to) continue;
      const key = [from, to].sort().join(" ↔ ");
      const s = corridorMap.get(key) ?? new Set<string>(); s.add(route.id); corridorMap.set(key, s);
    }
  }
  const corridors: Corridor[] = Array.from(corridorMap.entries()).filter(([, s]) => s.size >= 2).map(([label, s]) => ({ label, routeCount: s.size })).sort((a, b) => b.routeCount - a.routeCount).slice(0, 5);
  return { warnings: warnings.slice(0, 8), hubs, corridors };
}

// ── Rolling stock lookup ──────────────────────────────────────────────────────

const ROLLING_STOCK: Record<string, { fleet: string; capacity: string; year: string; note: string }[]> = {
  subway: [
    { fleet: "TR Series (Bombardier)", capacity: "1,140 / 6-car", year: "2011–present", note: "Lines 1 & 2 primary fleet" },
    { fleet: "T1 Series (Hawker-Siddeley)", capacity: "960 / 6-car", year: "1995–present", note: "Line 2 supplemental" },
  ],
  lrt: [
    { fleet: "Alstom Citadis Spirit", capacity: "260 / train", year: "2022–present", note: "Eglinton Crosstown" },
    { fleet: "Bombardier Thunder", capacity: "280 / train", year: "2021–present", note: "Finch West LRT" },
  ],
  streetcar: [
    { fleet: "Bombardier Flexity Outlook", capacity: "251 / vehicle", year: "2014–present", note: "Full CLRV/ALRV replacement" },
  ],
  bus: [
    { fleet: "Nova Bus LFS", capacity: "85 / bus", year: "2018–present", note: "Standard 40-ft diesel/hybrid" },
    { fleet: "New Flyer XDE40", capacity: "85 / bus", year: "2017–present", note: "Hybrid-electric" },
    { fleet: "New Flyer XE40 (eBus)", capacity: "85 / bus", year: "2022–present", note: "Battery-electric" },
  ],
  go_train: [
    { fleet: "Bombardier BiLevel", capacity: "162 / car", year: "1977–present", note: "Core fleet, push-pull" },
    { fleet: "MPI MP40PH-3C Locomotive", capacity: "N/A", year: "2007–present", note: "Primary GO motive power" },
    { fleet: "Alstom Coradia iLint (planned)", capacity: "300 / trainset", year: "2027 target", note: "Hydrogen EMU for electrification" },
  ],
};

// ── Accessibility analysis ────────────────────────────────────────────────────

function computeAccessibility(routes: Route[]) {
  const accessibleTypes = new Set(["subway", "lrt", "go_train"]);
  const total = routes.length;
  const accessible = routes.filter((r) => accessibleTypes.has(r.type)).length;
  const spacings: number[] = [];
  for (const r of routes) {
    for (let i = 1; i < r.stops.length; i++) {
      spacings.push(haversineKm(r.stops[i - 1]!.coords, r.stops[i]!.coords) * 1000);
    }
  }
  const avgSpacingM = spacings.length > 0 ? Math.round(spacings.reduce((a, b) => a + b, 0) / spacings.length) : 0;
  const shortSpacings = spacings.filter((s) => s < 400).length;
  const longGaps = spacings.filter((s) => s > 2000).length;
  const hubRoutes = routes.filter((r) => r.type === "subway" || r.type === "lrt");
  return { total, accessible, pct: total > 0 ? Math.round((accessible / total) * 100) : 0, avgSpacingM, shortSpacings, longGaps, hubRoutes: hubRoutes.length };
}

// ── Feasibility report ────────────────────────────────────────────────────────

function gradeColor(grade: string): string {
  return grade === "A" ? "#059669" : grade === "B" ? "#0284c7" : grade === "C" ? "#d97706" : grade === "D" ? "#ea580c" : "#dc2626";
}

function scoreBar(score: number, color: string): string {
  return `<div style="background:#f1f5f9;border-radius:4px;height:8px;margin-top:4px;overflow:hidden"><div style="height:100%;width:${score}%;background:${color};border-radius:4px;transition:width 1s ease"></div></div>`;
}

function openReportTab(route: Route, allRoutes: Route[]): void {
  const score = scoreRoute(route, allRoutes);
  const km = routeLengthKm(route);
  const headway = parseHeadway(route.frequency, route.servicePattern);
  const costPerKm = route.type === "subway" ? 500 : route.type === "lrt" ? 120 : route.type === "go_train" ? 80 : route.type === "streetcar" ? 50 : 8;
  const totalCost = (km * costPerKm);
  const dailyRidership = Math.round(route.stops.length * (headway < 10 ? 3200 : headway < 20 ? 1800 : 900));
  const annualOp = Math.round(km * 1.8);
  const costRecovery = Math.round((dailyRidership * 365 * 2.5) / (annualOp * 1_000_000) * 100);
  const gc = gradeColor(score.grade);
  const typeName = route.type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const recs: string[] = [];
  if (score.frequency < 60) recs.push(`Increase service frequency — current ${headway} min headway limits ridership potential.`);
  if (score.coverage < 60) recs.push(`Add intermediate stops to improve area coverage.`);
  if (score.connectivity < 50) recs.push(`Route has limited connections — consider transfer hubs at key junctions.`);
  if (score.efficiency < 50) recs.push(`Route alignment is circuitous — review corridor for a straighter path.`);
  if (score.overall >= 75) recs.push(`Route performs well overall. Recommend prioritising for early construction phase.`);
  if (recs.length === 0) recs.push(`No critical issues identified. Proceed to detailed engineering study.`);

  const recsHtml = recs.map((r, i) => `<div style="display:flex;gap:10px;padding:10px 12px;background:${i % 2 === 0 ? "#f8fafc" : "#fff"};border-radius:6px;margin-bottom:6px"><span style="color:#64748b;font-size:13px;margin-top:1px">→</span><span style="font-size:13px;color:#334155;line-height:1.5">${r}</span></div>`).join("");

  const stopsHtml = route.stops.slice(0, 12).map((s, i) => `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #f1f5f9"><span style="width:22px;height:22px;background:#e2e8f0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#64748b;flex-shrink:0">${i + 1}</span><span style="font-size:12px;color:#334155">${s.name || `Stop ${i + 1}`}</span></div>`).join("") + (route.stops.length > 12 ? `<p style="font-size:11px;color:#94a3b8;padding-top:6px">+ ${route.stops.length - 12} more stations</p>` : "");

  const reportHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Feasibility Report — ${route.name}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;color:#1e293b;min-height:100vh}
  @keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
  @keyframes fillBar{from{width:0}to{width:var(--w)}}
  .page{max-width:820px;margin:0 auto;padding:40px 24px 80px}
  .header{background:#0f172a;border-radius:16px;padding:36px 40px;margin-bottom:28px;color:#fff;position:relative;overflow:hidden}
  .header::after{content:'';position:absolute;right:-60px;top:-60px;width:240px;height:240px;border-radius:50%;background:rgba(255,255,255,0.03)}
  .badge{display:inline-block;background:rgba(255,255,255,0.12);color:#cbd5e1;font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;margin-bottom:14px;letter-spacing:.5px;text-transform:uppercase}
  .title{font-size:28px;font-weight:800;letter-spacing:-.5px;margin-bottom:6px}
  .subtitle{font-size:14px;color:#94a3b8}
  .grade-badge{position:absolute;right:40px;top:50%;transform:translateY(-50%);width:72px;height:72px;border-radius:50%;background:rgba(255,255,255,0.1);border:2px solid rgba(255,255,255,0.2);display:flex;flex-direction:column;align-items:center;justify-content:center}
  .grade-letter{font-size:32px;font-weight:900;color:#fff;line-height:1}
  .grade-sub{font-size:10px;color:#94a3b8;margin-top:2px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
  .grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:16px}
  .card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}
  .card-label{font-size:11px;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
  .card-value{font-size:22px;font-weight:800;color:#0f172a}
  .card-sub{font-size:12px;color:#94a3b8;margin-top:2px}
  .section{background:#fff;border-radius:12px;padding:24px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
  .section-title{font-size:14px;font-weight:700;color:#0f172a;margin-bottom:16px;display:flex;align-items:center;gap:8px}
  .section-title::before{content:'';display:block;width:3px;height:16px;background:${gc};border-radius:2px}
  .score-row{display:flex;align-items:center;gap:12px;margin-bottom:14px}
  .score-label{font-size:13px;color:#475569;width:100px;flex-shrink:0}
  .score-track{flex:1;background:#f1f5f9;border-radius:4px;height:8px;overflow:hidden}
  .score-fill{height:100%;border-radius:4px}
  .score-num{font-size:13px;font-weight:700;color:#0f172a;width:32px;text-align:right}
  .fin-row{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-bottom:1px solid #f1f5f9}
  .fin-label{font-size:13px;color:#64748b}
  .fin-value{font-size:15px;font-weight:700;color:#0f172a}
  .footer{text-align:center;margin-top:40px;font-size:11px;color:#cbd5e1}
  .chip{display:inline-flex;align-items:center;gap:4px;background:#f1f5f9;border-radius:20px;padding:4px 12px;font-size:12px;color:#475569;font-weight:500;margin-right:6px;margin-bottom:6px}
</style>
</head>
<body>
<div class="page" style="animation:fadeIn .4s ease both">

  <div class="header">
    <div class="badge">Feasibility Analysis · ${new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" })}</div>
    <div class="title">${route.name}</div>
    <div class="subtitle">${typeName} · ${km.toFixed(1)} km · ${route.stops.length} stations</div>
    <div class="grade-badge">
      <div class="grade-letter" style="color:${gc}">${score.grade}</div>
      <div class="grade-sub">${score.overall}/100</div>
    </div>
  </div>

  <div class="grid3">
    <div class="card"><div class="card-label">Est. Capital Cost</div><div class="card-value">$${totalCost >= 1000 ? (totalCost / 1000).toFixed(1) + "B" : totalCost.toLocaleString() + "M"}</div><div class="card-sub">@ $${costPerKm}M per km</div></div>
    <div class="card"><div class="card-label">Daily Ridership</div><div class="card-value">${dailyRidership.toLocaleString()}</div><div class="card-sub">estimated boardings</div></div>
    <div class="card"><div class="card-label">Fare Recovery</div><div class="card-value">${costRecovery}%</div><div class="card-sub">est. at $2.50/trip</div></div>
  </div>

  <div class="grid2">
    <div class="section">
      <div class="section-title">Route Overview</div>
      <div style="margin-bottom:12px">
        <span class="chip">📏 ${km.toFixed(1)} km</span>
        <span class="chip">🚉 ${route.stops.length} stops</span>
        <span class="chip">⏱ ${headway} min headway</span>
      </div>
      <div style="font-size:12px;color:#64748b;margin-bottom:6px">Corridor</div>
      <div style="font-size:14px;font-weight:600;color:#0f172a">${route.stops[0]?.name ?? "—"}</div>
      <div style="color:#94a3b8;font-size:12px;padding:2px 0">↓</div>
      <div style="font-size:14px;font-weight:600;color:#0f172a">${route.stops[route.stops.length - 1]?.name ?? "—"}</div>
    </div>
    <div class="section">
      <div class="section-title">Stations</div>
      ${stopsHtml}
    </div>
  </div>

  <div class="section">
    <div class="section-title">Performance Scores</div>
    <div class="score-row"><div class="score-label">Frequency</div><div class="score-track"><div class="score-fill" style="width:${score.frequency}%;background:#0ea5e9"></div></div><div class="score-num">${score.frequency}</div></div>
    <div class="score-row"><div class="score-label">Coverage</div><div class="score-track"><div class="score-fill" style="width:${score.coverage}%;background:#10b981"></div></div><div class="score-num">${score.coverage}</div></div>
    <div class="score-row"><div class="score-label">Connectivity</div><div class="score-track"><div class="score-fill" style="width:${score.connectivity}%;background:#f43f5e"></div></div><div class="score-num">${score.connectivity}</div></div>
    <div class="score-row"><div class="score-label">Efficiency</div><div class="score-track"><div class="score-fill" style="width:${score.efficiency}%;background:#f59e0b"></div></div><div class="score-num">${score.efficiency}</div></div>
    <div style="margin-top:4px;padding-top:16px;border-top:1px solid #f1f5f9">
      <div class="score-row"><div class="score-label" style="font-weight:700;color:#0f172a">Overall</div><div class="score-track"><div class="score-fill" style="width:${score.overall}%;background:${gc}"></div></div><div class="score-num" style="color:${gc}">${score.overall}</div></div>
    </div>
  </div>

  <div class="section">
    <div class="section-title">Financial Estimate</div>
    <div class="fin-row"><div class="fin-label">Estimated capital cost</div><div class="fin-value">$${totalCost >= 1000 ? (totalCost / 1000).toFixed(2) + "B" : totalCost.toLocaleString() + "M"}</div></div>
    <div class="fin-row"><div class="fin-label">Annual operating cost</div><div class="fin-value">~$${annualOp}M / yr</div></div>
    <div class="fin-row"><div class="fin-label">Estimated daily ridership</div><div class="fin-value">${dailyRidership.toLocaleString()} boardings</div></div>
    <div class="fin-row" style="border-bottom:none"><div class="fin-label">Est. annual farebox revenue</div><div class="fin-value">~$${Math.round(dailyRidership * 365 * 2.5 / 1_000_000)}M / yr</div></div>
  </div>

  <div class="section">
    <div class="section-title">Recommendations</div>
    ${recsHtml}
  </div>

  <div class="footer">
    Generated by Transit Planner · ${new Date().toISOString()} · Estimates are indicative only and do not constitute professional engineering advice.
  </div>
</div>
</body>
</html>`;

  const win = window.open("", "_blank");
  if (!win) return;

  const loadingHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Generating Report…</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;color:#fff}
  @keyframes progress{from{width:0}to{width:100%}}
  .label{font-size:14px;color:#94a3b8;margin-bottom:20px;letter-spacing:.5px}
  .track{width:280px;height:4px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden}
  .bar{height:100%;background:linear-gradient(90deg,#6366f1,#06b6d4);border-radius:4px;animation:progress 1.1s cubic-bezier(.4,0,.2,1) forwards}
  .title{font-size:22px;font-weight:800;margin-bottom:8px}
</style>
</head>
<body>
  <div class="title">Feasibility Report</div>
  <div class="label">Generating analysis for ${route.name}…</div>
  <div class="track"><div class="bar"></div></div>
</body>
</html>`;

  win.document.write(loadingHtml);
  win.document.close();

  setTimeout(() => {
    win.document.open();
    win.document.write(reportHtml);
    win.document.close();
  }, 1200);
}

// ── Cost estimator ────────────────────────────────────────────────────────────

function computeCostBreakdown(route: Route, tunnelPct: number, elevatedPct: number) {
  const surfacePct = Math.max(0, 100 - tunnelPct - elevatedPct);
  const km = routeLengthKm(route);
  const base = route.type === "subway" ? 500 : route.type === "lrt" ? 120 : route.type === "go_train" ? 80 : route.type === "streetcar" ? 50 : 8;
  const blended = base * (surfacePct / 100) + base * 5 * (tunnelPct / 100) + base * 2 * (elevatedPct / 100);
  return { surfacePct, tunnelPct, elevatedPct, capitalM: km * blended, operatingM: km * 1.8, totalKm: km };
}

// ── Elevation model (rough GTA terrain) ───────────────────────────────────────

function estimateElevationM(coords: [number, number]): number {
  const [lng, lat] = coords;
  return Math.round(76 + Math.max(0, (lat - 43.63) * 620) + (lng < -79.8 && lat < 43.55 ? 50 : 0) + Math.sin(lat * 13.7 + lng * 9.3) * 8);
}

// ── City presets ──────────────────────────────────────────────────────────────

const CITY_PRESETS = [
  { name: "Toronto", lat: 43.6532, lng: -79.3832, zoom: 11 },
  { name: "Mississauga", lat: 43.589, lng: -79.6441, zoom: 11 },
  { name: "Hamilton", lat: 43.2557, lng: -79.8711, zoom: 12 },
  { name: "Kitchener", lat: 43.4516, lng: -80.4925, zoom: 12 },
  { name: "Barrie", lat: 44.3894, lng: -79.6903, zoom: 12 },
  { name: "Ottawa", lat: 45.4215, lng: -75.6972, zoom: 11 },
  { name: "Montréal", lat: 45.5017, lng: -73.5673, zoom: 11 },
  { name: "Vancouver", lat: 49.2827, lng: -123.1207, zoom: 11 },
  { name: "New York", lat: 40.7128, lng: -74.006, zoom: 11 },
  { name: "London UK", lat: 51.5074, lng: -0.1278, zoom: 11 },
  { name: "Tokyo", lat: 35.6762, lng: 139.6503, zoom: 11 },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-wide mb-1.5">{children}</p>;
}

function StatCard({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="rounded-lg bg-stone-50 px-2.5 py-2">
      <p className="text-[10px] text-stone-400 font-medium">{label}</p>
      <p className="text-sm font-bold text-stone-800 leading-tight">{value}</p>
      {sub && <p className="text-[9px] text-stone-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${color}`}>
      {children}
    </span>
  );
}

function ToggleRow({
  label, sub, on, onToggle, activeColor = "bg-sky-500",
}: { label: string; sub: string; on: boolean; onToggle: () => void; activeColor?: string }) {
  return (
    <button
      onClick={onToggle}
      className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors ${on ? "border-sky-300 bg-sky-50" : "border-stone-200 hover:border-stone-300"}`}
    >
      <div className="flex-1 min-w-0">
        <p className={`text-xs font-semibold truncate ${on ? "text-sky-700" : "text-stone-600"}`}>{label}</p>
        <p className="text-[10px] text-stone-400 truncate">{sub}</p>
      </div>
      <div className={`relative h-4 w-7 rounded-full transition-colors shrink-0 ${on ? activeColor : "bg-stone-200"}`}>
        <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${on ? "translate-x-3.5" : "translate-x-0.5"}`} />
      </div>
    </button>
  );
}

// ── Constants ─────────────────────────────────────────────────────────────────

const GRADE_COLOR: Record<string, string> = {
  A: "text-emerald-600", B: "text-sky-600", C: "text-amber-500", D: "text-orange-500", F: "text-rose-600",
};
const GRADE_BG: Record<string, string> = {
  A: "bg-emerald-50 border-emerald-200", B: "bg-sky-50 border-sky-200", C: "bg-amber-50 border-amber-200", D: "bg-orange-50 border-orange-200", F: "bg-rose-50 border-rose-200",
};
const BAR_COLOR: Record<string, string> = {
  // 4 distinct categorical hues — connectivity uses rose (was purple) so it
  // stays distinguishable from the teal UI accent and the emerald coverage bar.
  frequency: "bg-sky-500", coverage: "bg-emerald-500", connectivity: "bg-rose-500", efficiency: "bg-amber-500",
};
const GRADE_RANK: Record<string, number> = { A: 5, B: 4, C: 3, D: 2, F: 1 };

const MODE_CONFIG: Record<string, { label: string; color: string }> = {
  subway: { label: "Subway / LRT", color: "#6B4FBB" },
  streetcar: { label: "Streetcar",   color: "#ED1C24" },
  bus:       { label: "Bus",          color: "#FFB000" },
  go_train:  { label: "GO Train",     color: "#00853F" },
};

// ── Hour labels ───────────────────────────────────────────────────────────────

function isRouteActiveAt(route: Route, hour: number): boolean {
  if (route.servicePattern) {
    const { startHour, endHour } = route.servicePattern;
    return hour >= startHour && hour <= endHour;
  }
  const hw = parseHeadway(route.frequency, route.servicePattern);
  if (hw > 30) return (hour >= 7 && hour <= 9) || (hour >= 16 && hour <= 19);
  return hour >= 6 && hour <= 23;
}

// ── Props ─────────────────────────────────────────────────────────────────────

type Tab = "stats" | "cities" | "score" | "issues" | "vs" | "sim" | "access" | "report" | "stock" | "station" | "property" | "places" | "cost" | "gaps" | "catchment" | "export" | "elevation" | "disruption" | "ridership" | "assistant";

interface Props {
  routes: Route[];
  hiddenRoutes: Set<string>;
  selectedRoute: Route | null;
  stationPopulations: Map<string, number>;
  onZoomToCity: (lat: number, lng: number, zoom: number) => void;
  isochroneOrigin: [number, number] | null;
  onSetIsochroneOrigin: (coords: [number, number] | null) => void;
  isochroneMinutes: number;
  onSetIsochroneMinutes: (m: number) => void;
  // catchment
  showCatchment: boolean;
  onToggleCatchment: (v: boolean) => void;
  catchmentRadius: number;
  onSetCatchmentRadius: (r: number) => void;
  // disruption
  showDisruption: boolean;
  onToggleDisruption: (v: boolean) => void;
  disruptionRadius: number;
  onSetDisruptionRadius: (r: number) => void;
  disruptionRouteId: string;
  onSetDisruptionRouteId: (id: string) => void;
  // measure
  measureMode: boolean;
  onToggleMeasureMode: (v: boolean) => void;
  measureDistanceKm: number | null;
  // units
  imperial?: boolean;
  pickingIsochroneOrigin?: boolean;
  onStartPickIsochroneOrigin?: () => void;
  onExportMapPng?: () => void;
  onExportMapPdf?: () => void;
  onExportSchematic?: () => void;
  onCopyShareLink?: () => void;
  shareLinkCopied?: boolean;
  style?: React.CSSProperties;
  isoMode?: "walking" | "cycling" | "driving";
  onSetIsoMode?: (m: "walking" | "cycling" | "driving") => void;
  onSimUpdate?: (hour: number | null, activeIds: string[]) => void;
  onOpenGameMode?: () => void;
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ExperimentalPanel({
  routes, hiddenRoutes, selectedRoute, stationPopulations,
  onZoomToCity,
  isochroneOrigin, onSetIsochroneOrigin,
  isochroneMinutes, onSetIsochroneMinutes,
  showCatchment, onToggleCatchment, catchmentRadius, onSetCatchmentRadius,
  showDisruption, onToggleDisruption, disruptionRadius, onSetDisruptionRadius, disruptionRouteId, onSetDisruptionRouteId,
  measureMode, onToggleMeasureMode, measureDistanceKm,
  imperial = false,
  pickingIsochroneOrigin = false, onStartPickIsochroneOrigin,
  onExportMapPng, onExportMapPdf, onExportSchematic, onCopyShareLink, shareLinkCopied = false,
  style,
  isoMode = "walking", onSetIsoMode,
  onSimUpdate,
  onOpenGameMode,
}: Props) {
  const fmtDist = (km: number) => imperial
    ? `${(km * 0.621371).toFixed(2)} mi`
    : `${km.toFixed(2)} km`;
  const fmtRadius = (m: number) => imperial
    ? `${(m * 3.28084).toFixed(0)} ft`
    : `${m} m`;
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab | null>(null);
  const [compareA, setCompareA] = useState("");
  const [compareB, setCompareB] = useState("");
  const [simHour, setSimHour] = useState(8);
  const [simPlaying, setSimPlaying] = useState(false);
  const simIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (simPlaying) {
      simIntervalRef.current = setInterval(() => setSimHour((h) => (h + 1) % 24), 600);
    } else {
      if (simIntervalRef.current) clearInterval(simIntervalRef.current);
    }
    return () => { if (simIntervalRef.current) clearInterval(simIntervalRef.current); };
  }, [simPlaying]);
  // Notify parent of simulation state so it can dim map layers
  useEffect(() => {
    if (!onSimUpdate) return;
    if (simPlaying) {
      const ids = routes.filter((r) => isRouteActiveAt(r, simHour)).map((r) => r.id);
      onSimUpdate(simHour, ids);
    } else {
      onSimUpdate(null, []);
    }
  }, [simHour, simPlaying, routes]);
  const [reportRouteId, setReportRouteId] = useState("");
  const [stockType, setStockType] = useState<keyof typeof ROLLING_STOCK>("subway");
  // isoOriginId state moved into IsochroneDetails (lives inline in the Layers dropdown now)
  const [stationStyle, setStationStyle] = useState<"underground" | "elevated" | "surface">("underground");
  const [propRouteId, setPropRouteId] = useState("");
  const [costRouteId, setCostRouteId] = useState("");
  const [tunnelPct, setTunnelPct] = useState(30);
  const [elevatedPct, setElevatedPct] = useState(10);
  const [exportDone, setExportDone] = useState<string | null>(null);
  const [elevRouteId, setElevRouteId] = useState("");

  const visibleRoutes = useMemo(() => routes.filter((r) => !hiddenRoutes.has(r.id)), [routes, hiddenRoutes]);

  // ── Stats ──
  const net = useMemo(() => {
    const byMode: Record<string, number> = {};
    for (const r of routes) {
      const k = r.type === "lrt" ? "subway" : r.type;
      byMode[k] = (byMode[k] ?? 0) + 1;
    }
    const totalStops = routes.reduce((s, r) => s + r.stops.length, 0);
    const totalPop = Array.from(stationPopulations.values()).reduce((a, b) => a + b, 0);
    const headways = routes.filter((r) => r.frequency && r.frequency !== "—").map((r) => parseHeadway(r.frequency, r.servicePattern));
    const avgHeadway = headways.length > 0 ? Math.round(headways.reduce((a, b) => a + b, 0) / headways.length) : null;
    const totalKm = routes.reduce((s, r) => s + routeLengthKm(r), 0);
    return { byMode, totalStops, totalPop, avgHeadway, totalKm };
  }, [routes, stationPopulations]);

  // ── Cities ──
  const cities = useMemo(() => computeCityCoverage(routes), [routes]);

  // ── Score ──
  const scoreCard = useMemo(() => (selectedRoute ? scoreRoute(selectedRoute, routes) : null), [selectedRoute, routes]);

  // ── Diagnostics ──
  const diag = useMemo(() => buildDiagnostics(routes), [routes]);

  // ── Compare ──
  const routeA = useMemo(() => routes.find((r) => r.id === compareA) ?? null, [routes, compareA]);
  const routeB = useMemo(() => routes.find((r) => r.id === compareB) ?? null, [routes, compareB]);
  const scoreA = useMemo(() => (routeA ? scoreRoute(routeA, routes) : null), [routeA, routes]);
  const scoreB = useMemo(() => (routeB ? scoreRoute(routeB, routes) : null), [routeB, routes]);

  // ── Simulation ──
  const simActive = useMemo(() => routes.filter((r) => isRouteActiveAt(r, simHour)), [routes, simHour]);
  const simByMode = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of simActive) { const k = r.type === "lrt" ? "subway" : r.type; m[k] = (m[k] ?? 0) + 1; }
    return m;
  }, [simActive]);
  const hourLabel = (h: number) => `${h === 0 ? "12" : h > 12 ? h - 12 : h}${h < 12 ? "am" : "pm"}`;
  const simBars = useMemo(() => Array.from({ length: 24 }, (_, h) => routes.filter((r) => isRouteActiveAt(r, h)).length), [routes]);
  const maxBar = Math.max(...simBars, 1);

  // ── Accessibility ──
  const access = useMemo(() => computeAccessibility(routes), [routes]);

  // ── Property ──
  const propRoute = useMemo(() => routes.find((r) => r.id === propRouteId) ?? null, [routes, propRouteId]);

  // ── Cost / Ridership / Elevation / Gaps ──
  const costRoute = useMemo(() => routes.find((r) => r.id === costRouteId) ?? null, [routes, costRouteId]);
  const costBreakdown = useMemo(() => costRoute ? computeCostBreakdown(costRoute, tunnelPct, elevatedPct) : null, [costRoute, tunnelPct, elevatedPct]);
  const ridershipForecasts = useMemo(() => routes.map((r) => ({ route: r, daily: forecastRouteRidership(r, stationPopulations) })).sort((a, b) => b.daily - a.daily).slice(0, 10), [routes, stationPopulations]);
  const elevRoute = useMemo(() => routes.find((r) => r.id === elevRouteId) ?? null, [routes, elevRouteId]);
  const elevProfile = useMemo(() => elevRoute ? elevRoute.stops.map((s) => ({ name: s.name, elev: estimateElevationM(s.coords) })) : [], [elevRoute]);
  const gapCenters = useMemo(() => {
    const served = new Set<string>();
    for (const r of routes) for (const s of r.stops) for (const c of POPULATION_CENTERS) {
      if (!served.has(c.id) && haversineKm(s.coords, [c.lng, c.lat]) <= c.serviceRadiusKm) served.add(c.id);
    }
    return POPULATION_CENTERS.filter((c) => !served.has(c.id)).sort((a, b) => b.population - a.population);
  }, [routes]);

  const FEATURES: { id: Tab; label: string; icon: string; desc: string; accent: string }[] = [
    { id: "stats",     label: "Network Stats",    icon: "◈", desc: "Routes, stops, headways",       accent: "text-sky-600"     },
    { id: "cities",    label: "City Coverage",    icon: "◎", desc: "Population centers served",     accent: "text-emerald-600" },
    { id: "score",     label: "Route Score",      icon: "◆", desc: "Grade selected route",          accent: "text-indigo-600"  },
    { id: "issues",    label: "Network Issues",   icon: "⚠", desc: "Gaps, warnings, hubs",          accent: "text-amber-600"   },
    { id: "vs",        label: "Compare Routes",   icon: "⇌", desc: "Side-by-side scorecard",        accent: "text-sky-600"     },
    { id: "sim",       label: "Simulation",        icon: "◷", desc: "Service by hour of day",        accent: "text-indigo-600"  },
    { id: "access",    label: "Accessibility",    icon: "♿", desc: "Spacing & inclusive access",    accent: "text-indigo-600"    },
    { id: "report",    label: "Feasibility Doc",  icon: "◉", desc: "Auto-generate analysis PDF",    accent: "text-rose-600"    },
    { id: "stock",     label: "Rolling Stock",    icon: "◈", desc: "Fleet & vehicle info",          accent: "text-stone-600"   },
    { id: "station",   label: "Station Design",   icon: "◫", desc: "Style & property footprint",    accent: "text-indigo-600"  },
    { id: "property",  label: "Land Acquisition", icon: "◰", desc: "Properties along corridor",     accent: "text-amber-600"   },
    { id: "places",    label: "Jump to Place",    icon: "◎", desc: "Fly to city presets",           accent: "text-sky-600"     },
    { id: "cost",      label: "Cost Estimator",   icon: "◆", desc: "Capital & operating costs",     accent: "text-emerald-600" },
    { id: "gaps",      label: "Network Gaps",     icon: "◍", desc: "Unserved population centres",   accent: "text-rose-600"    },
    { id: "catchment", label: "Catchment Zones",  icon: "◎", desc: "Station radius overlay",        accent: "text-emerald-600" },
    { id: "export",    label: "Export Data",      icon: "↓",  desc: "CSV & Markdown downloads",      accent: "text-stone-600"   },
    { id: "elevation", label: "Elevation Profile",icon: "◬", desc: "Terrain height along route",    accent: "text-indigo-600"    },
    { id: "disruption",label: "Disruption Zones", icon: "◯", desc: "Noise & impact buffers",        accent: "text-rose-600"    },
    { id: "ridership", label: "Ridership Forecast",icon:"◈", desc: "Gravity model projections",     accent: "text-indigo-600"  },
    { id: "assistant", label: "AI Assistant",      icon:"✦", desc: "Chat with your network data",   accent: "text-teal-600"  },
  ];

  const activeFeature = tab ? FEATURES.find((f) => f.id === tab) : null;

  return (
    <div className="rounded-xl border border-[#D7D7D7] bg-white shadow-sm w-64 overflow-hidden flex flex-col max-h-[calc(100vh-120px)]" style={style}>
      {/* header */}
      <button onClick={() => { setOpen((v) => !v); if (open) setTab(null); }} className="flex w-full items-center justify-between px-4 py-3 text-left shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-stone-400 uppercase tracking-widest">Analysis</span>
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold text-violet-600 uppercase tracking-wide">beta</span>
        </div>
        <svg viewBox="0 0 10 10" fill="currentColor" className={`h-2.5 w-2.5 text-stone-400 transition-transform shrink-0 ${open ? "" : "-rotate-90"}`}>
          <path d="M2 3l3 4 3-4H2z" />
        </svg>
      </button>

      {open && (
        <>
          {/* feature list or detail header */}
          {tab ? (
            <div className="border-t border-stone-100 flex items-center gap-2 px-3 py-2 shrink-0">
              <button onClick={() => setTab(null)} className="text-stone-400 hover:text-stone-700 transition-colors text-[11px] flex items-center gap-1">
                <svg viewBox="0 0 10 10" fill="currentColor" className="h-2 w-2 rotate-90"><path d="M2 3l3 4 3-4H2z" /></svg>
                Back
              </button>
              <span className="h-3 w-px bg-stone-200" />
              <span className={`text-xs font-semibold ${activeFeature?.accent ?? "text-stone-800"}`}>{activeFeature?.label}</span>
            </div>
          ) : (
            <div className="border-t border-stone-100 px-3 pt-2.5 pb-1 shrink-0">
              <p className="text-[10px] text-stone-400">Select a feature to open</p>
            </div>
          )}

          {/* feature grid (home) */}
          {!tab && (
            <div className="overflow-y-auto flex-1 px-3 pb-3">
              <div className="grid grid-cols-2 gap-1.5 pt-1.5">
                {FEATURES.map(({ id, label, icon, desc, accent }) => (
                  <button
                    key={id}
                    onClick={() => setTab(id)}
                    className="text-left rounded-xl border border-stone-100 bg-stone-50 px-2.5 py-2.5 hover:border-stone-200 hover:bg-white transition-all group"
                  >
                    <span className={`text-base leading-none ${accent}`}>{icon}</span>
                    <p className="mt-1 text-[11px] font-semibold text-stone-700 leading-tight group-hover:text-stone-900">{label}</p>
                    <p className="mt-0.5 text-[9px] text-stone-400 leading-tight">{desc}</p>
                  </button>
                ))}
                {onOpenGameMode && (
                  <button
                    onClick={onOpenGameMode}
                    className="text-left rounded-xl border border-indigo-100 bg-indigo-50 px-2.5 py-2.5 hover:border-indigo-200 hover:bg-indigo-50/80 transition-all group"
                  >
                    <span className="text-base leading-none">🎮</span>
                    <p className="mt-1 text-[11px] font-semibold text-indigo-700 leading-tight">Game Mode</p>
                    <p className="mt-0.5 text-[9px] text-indigo-400 leading-tight">Interactive planning game</p>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* feature detail */}
          {tab && (
          <div className="px-4 pb-4 pt-2 overflow-y-auto flex-1">

            {/* ── Stats ── */}
            {tab === "stats" && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="Routes"      value={routes.length} />
                  <StatCard label="Visible"     value={visibleRoutes.length} />
                  <StatCard label="Stops"       value={net.totalStops.toLocaleString()} />
                  <StatCard label="Avg headway" value={net.avgHeadway ? `${net.avgHeadway} min` : "—"} />
                </div>
                <div className="rounded-lg bg-stone-50 px-2.5 py-2">
                  <p className="text-[10px] text-stone-400 font-medium mb-1.5">By mode</p>
                  <div className="space-y-1">
                    {Object.entries(MODE_CONFIG).map(([type, { label, color }]) => {
                      const count = net.byMode[type] ?? 0;
                      if (count === 0) return null;
                      return (
                        <div key={type} className="flex items-center gap-2">
                          <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                          <span className="flex-1 text-[11px] text-stone-600">{label}</span>
                          <span className="text-[11px] font-semibold text-stone-800">{count}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {net.totalPop > 0 && <StatCard label="Pop. served" value={`${(net.totalPop / 1_000_000).toFixed(2)}M`} />}
                  <StatCard label="Network" value={`${net.totalKm.toFixed(0)} km`} />
                </div>
              </div>
            )}

            {/* ── Cities ── */}
            {tab === "cities" && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="Cities served" value={<>{cities.citiesServed} <span className="text-stone-400 font-normal text-xs">/ {cities.totalCities}</span></>} />
                  <StatCard label="Coverage" value={`${cities.pct}%`} />
                </div>
                <div className="rounded-lg bg-stone-50 px-2.5 py-2">
                  <div className="flex justify-between text-[10px] text-stone-400 mb-1">
                    <span>Population served</span>
                    <span>{(cities.servedPop / 1_000_000).toFixed(2)}M / {(cities.totalPop / 1_000_000).toFixed(2)}M</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-stone-200 overflow-hidden">
                    <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${cities.pct}%` }} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wide mb-1">Served</p>
                    <div className="space-y-1">
                      {cities.served.length === 0 ? <p className="text-[10px] text-stone-400">None yet</p> : cities.served.map((c) => (
                        <div key={c.id} className="flex items-center justify-between rounded bg-stone-50 px-2 py-1">
                          <span className="text-[10px] text-stone-700 truncate flex-1">{c.name}</span>
                          <span className="text-[9px] text-stone-400 ml-1 shrink-0">{(c.population / 1000).toFixed(0)}k</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="text-[10px] font-semibold text-stone-400 uppercase tracking-wide mb-1">Gaps</p>
                    <div className="space-y-1">
                      {cities.gaps.length === 0 ? <p className="text-[10px] text-stone-400">All covered!</p> : cities.gaps.map((c) => (
                        <div key={c.id} className="flex items-center justify-between rounded bg-stone-50 px-2 py-1">
                          <span className="text-[10px] text-stone-700 truncate flex-1">{c.name}</span>
                          <span className="text-[9px] text-stone-400 ml-1 shrink-0">{(c.population / 1000).toFixed(0)}k</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ── Score ── */}
            {tab === "score" && (
              <div>
                {!selectedRoute ? (
                  <p className="text-xs text-stone-400 text-center py-6">Select a route from the Lines panel</p>
                ) : !scoreCard ? null : (
                  <div className="space-y-3">
                    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${GRADE_BG[scoreCard.grade]}`}>
                      <span className={`text-4xl font-black leading-none ${GRADE_COLOR[scoreCard.grade]}`}>{scoreCard.grade}</span>
                      <div>
                        <p className="text-[10px] text-stone-400">Overall score</p>
                        <p className="text-xl font-bold text-stone-800 leading-none">
                          {scoreCard.overall}<span className="text-xs font-normal text-stone-400">/100</span>
                        </p>
                        <p className="text-[11px] text-stone-500 mt-0.5 truncate max-w-32">{selectedRoute.name}</p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      {([
                        { key: "frequency",    label: "Frequency",    score: scoreCard.frequency,    hint: `${Math.round(parseHeadway(selectedRoute.frequency, selectedRoute.servicePattern))} min` },
                        { key: "coverage",     label: "Coverage",     score: scoreCard.coverage,     hint: `${selectedRoute.stops.length} stops` },
                        { key: "connectivity", label: "Connectivity", score: scoreCard.connectivity, hint: "cross-route transfers" },
                        { key: "efficiency",   label: "Efficiency",   score: scoreCard.efficiency,   hint: "alignment ratio" },
                      ] as const).map(({ key, label, score, hint }) => (
                        <div key={key}>
                          <div className="flex justify-between items-baseline mb-0.5">
                            <div>
                              <span className="text-[11px] font-medium text-stone-600">{label}</span>
                              <span className="ml-1 text-[9px] text-stone-400">{hint}</span>
                            </div>
                            <span className="text-[11px] font-bold text-stone-700">{score}</span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-stone-100 overflow-hidden">
                            <div className={`h-full rounded-full ${BAR_COLOR[key]}`} style={{ width: `${score}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Issues ── */}
            {tab === "issues" && (
              <div className="space-y-3">
                <div>
                  <SectionLabel>Service warnings</SectionLabel>
                  {diag.warnings.length === 0 ? (
                    <div className="rounded-lg bg-emerald-50 border border-emerald-100 px-2.5 py-2">
                      <p className="text-[11px] text-emerald-700 font-medium">No issues detected</p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {diag.warnings.map((w, i) => (
                        <div key={i} className={`rounded-lg px-2.5 py-2 ${w.severity === "warn" ? "bg-amber-50 border border-amber-100" : "bg-stone-50"}`}>
                          <p className="text-[11px] font-semibold text-stone-700">{w.routeName}</p>
                          <p className="text-[10px] text-stone-500">{w.message}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <SectionLabel>Transfer hubs</SectionLabel>
                  {diag.hubs.length === 0 ? (
                    <p className="text-[11px] text-stone-400 rounded-lg bg-stone-50 px-2.5 py-2">No multi-route stops yet.</p>
                  ) : (
                    <div className="space-y-1">
                      {diag.hubs.map((h) => (
                        <div key={h.name} className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-[11px] font-semibold text-stone-700 truncate flex-1">{h.name}</p>
                            <Pill color="bg-indigo-100 text-indigo-700">{h.routeCount} lines</Pill>
                          </div>
                          <p className="text-[10px] text-stone-400 mt-0.5 truncate">{h.routeNames.slice(0, 3).join(" · ")}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <SectionLabel>Overlapping corridors</SectionLabel>
                  {diag.corridors.length === 0 ? (
                    <p className="text-[11px] text-stone-400 rounded-lg bg-stone-50 px-2.5 py-2">No shared corridors detected.</p>
                  ) : (
                    <div className="space-y-1">
                      {diag.corridors.map((c) => (
                        <div key={c.label} className="flex items-center justify-between rounded-lg bg-stone-50 px-2.5 py-2">
                          <span className="text-[10px] text-stone-600 truncate flex-1 mr-2">{c.label}</span>
                          <Pill color="bg-orange-100 text-orange-600">{c.routeCount} routes</Pill>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Layers / Isochrone moved to the top-toolbar Layers dropdown. */}

            {/* ── vs. ── */}
            {tab === "vs" && (
              <div className="space-y-3">
                {([{ label: "Route A", value: compareA, setter: setCompareA }, { label: "Route B", value: compareB, setter: setCompareB }] as const).map(({ label, value, setter }) => (
                  <div key={label}>
                    <p className="text-[10px] font-semibold text-stone-400 mb-1">{label}</p>
                    <select value={value} onChange={(e) => setter(e.target.value)} className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 bg-white">
                      <option value="">— pick a route —</option>
                      {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                ))}
                {routeA && routeB && scoreA && scoreB && (() => {
                  const lenA = routeLengthKm(routeA), lenB = routeLengthKm(routeB);
                  const hwA = parseHeadway(routeA.frequency, routeA.servicePattern), hwB = parseHeadway(routeB.frequency, routeB.servicePattern);
                  const rows = [
                    { label: "Grade",   va: scoreA.grade,         vb: scoreB.grade,         aWins: (GRADE_RANK[scoreA.grade] ?? 0) > (GRADE_RANK[scoreB.grade] ?? 0), bWins: (GRADE_RANK[scoreB.grade] ?? 0) > (GRADE_RANK[scoreA.grade] ?? 0) },
                    { label: "Score",   va: `${scoreA.overall}`,   vb: `${scoreB.overall}`,   aWins: scoreA.overall > scoreB.overall,       bWins: scoreB.overall > scoreA.overall },
                    { label: "Stops",   va: `${routeA.stops.length}`, vb: `${routeB.stops.length}`, aWins: routeA.stops.length > routeB.stops.length, bWins: routeB.stops.length > routeA.stops.length },
                    { label: "Length",  va: `${lenA.toFixed(1)}km`, vb: `${lenB.toFixed(1)}km`, aWins: lenA > lenB, bWins: lenB > lenA },
                    { label: "Headway", va: `${hwA}m`,             vb: `${hwB}m`,             aWins: hwA < hwB, bWins: hwB < hwA },
                    { label: "Freq.",   va: `${scoreA.frequency}`, vb: `${scoreB.frequency}`, aWins: scoreA.frequency > scoreB.frequency, bWins: scoreB.frequency > scoreA.frequency },
                    { label: "Connect", va: `${scoreA.connectivity}`, vb: `${scoreB.connectivity}`, aWins: scoreA.connectivity > scoreB.connectivity, bWins: scoreB.connectivity > scoreA.connectivity },
                  ];
                  return (
                    <div className="rounded-lg border border-stone-100 overflow-hidden">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-stone-50 border-b border-stone-100">
                            <th className="px-2.5 py-1.5 text-left text-[10px] font-semibold text-stone-400">Metric</th>
                            <th className="px-2 py-1.5 text-center text-[10px] font-bold" style={{ color: routeA.color }}>{routeA.shortName}</th>
                            <th className="px-2 py-1.5 text-center text-[10px] font-bold" style={{ color: routeB.color }}>{routeB.shortName}</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-stone-50">
                          {rows.map(({ label, va, vb, aWins, bWins }) => (
                            <tr key={label} className="hover:bg-stone-50">
                              <td className="px-2.5 py-1 text-[10px] text-stone-400">{label}</td>
                              <td className={`px-2 py-1 text-center text-[11px] font-semibold ${aWins ? "text-emerald-600" : "text-stone-600"}`}>{va}</td>
                              <td className={`px-2 py-1 text-center text-[11px] font-semibold ${bWins ? "text-emerald-600" : "text-stone-600"}`}>{vb}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ── Sim ── */}
            {tab === "sim" && (
              <div className="space-y-3">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <SectionLabel>Time of day</SectionLabel>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-stone-700">{hourLabel(simHour)}</span>
                      <button
                        onClick={() => setSimPlaying((v) => !v)}
                        className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${simPlaying ? "bg-indigo-500 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}
                        title={simPlaying ? "Pause" : "Play"}
                      >
                        {simPlaying ? (
                          <svg viewBox="0 0 10 10" fill="currentColor" className="h-2.5 w-2.5"><rect x="1.5" y="1" width="2.5" height="8" rx="0.5"/><rect x="6" y="1" width="2.5" height="8" rx="0.5"/></svg>
                        ) : (
                          <svg viewBox="0 0 10 10" fill="currentColor" className="h-2.5 w-2.5"><path d="M2 1.5l7 3.5-7 3.5V1.5z"/></svg>
                        )}
                      </button>
                    </div>
                  </div>
                  <input type="range" min={0} max={23} step={1} value={simHour} onChange={(e) => { setSimPlaying(false); setSimHour(Number(e.target.value)); }} className="w-full accent-indigo-500" />
                  {/* 24hr bar chart */}
                  <div className="flex items-end gap-px mt-2 h-8">
                    {simBars.map((count, h) => (
                      <div
                        key={h}
                        title={`${hourLabel(h)}: ${count} routes`}
                        className={`flex-1 rounded-sm transition-colors ${h === simHour ? "bg-indigo-500" : "bg-stone-200 hover:bg-stone-300"}`}
                        style={{ height: `${Math.max(8, (count / maxBar) * 100)}%` }}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between text-[9px] text-stone-300 mt-0.5">
                    <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>11pm</span>
                  </div>
                </div>
                <div className={`rounded-lg border px-3 py-2.5 ${simActive.length > 0 ? "bg-emerald-50 border-emerald-100" : "bg-stone-50 border-stone-100"}`}>
                  <p className="text-[10px] text-stone-400">Active routes at {hourLabel(simHour)}</p>
                  <p className={`text-xl font-black leading-tight ${simActive.length > 0 ? "text-emerald-700" : "text-stone-400"}`}>
                    {simActive.length}
                    <span className="text-xs font-normal text-stone-400 ml-1">/ {routes.length}</span>
                  </p>
                </div>
                <div className="space-y-1">
                  {Object.entries(MODE_CONFIG).map(([type, { label, color }]) => {
                    const count = simByMode[type] ?? 0;
                    if ((net.byMode[type] ?? 0) === 0) return null;
                    return (
                      <div key={type} className="flex items-center gap-2 rounded-lg bg-stone-50 px-2.5 py-1.5">
                        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: color }} />
                        <span className="flex-1 text-[11px] text-stone-600">{label}</span>
                        <span className="text-[11px] font-semibold text-stone-800">{count} <span className="text-stone-300">/ {net.byMode[type]}</span></span>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[9px] text-stone-300 text-center">Service patterns are indicative. Set servicePattern on routes for accurate sim.</p>
              </div>
            )}

            {/* ── Access ── */}
            {tab === "access" && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="Accessible routes" value={<>{access.accessible} <span className="text-stone-400 font-normal text-xs">/ {access.total}</span></>} sub="subway · lrt · GO" />
                  <StatCard label="Accessible %" value={`${access.pct}%`} sub="of all routes" />
                  <StatCard label="Avg stop spacing" value={`${access.avgSpacingM} m`} sub="across network" />
                  <StatCard label="Transfer hubs" value={access.hubRoutes} sub="subway / LRT lines" />
                </div>
                <div className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2 space-y-1.5">
                  <SectionLabel>Stop spacing analysis</SectionLabel>
                  {[
                    { label: "Dense clusters", value: access.shortSpacings, desc: "stops < 400 m apart", color: "text-sky-600" },
                    { label: "Long gaps",       value: access.longGaps,      desc: "gaps > 2 km",         color: "text-amber-600" },
                  ].map(({ label, value, desc, color }) => (
                    <div key={label} className="flex items-center justify-between">
                      <div>
                        <p className="text-[11px] font-medium text-stone-600">{label}</p>
                        <p className="text-[9px] text-stone-400">{desc}</p>
                      </div>
                      <span className={`text-sm font-bold ${color}`}>{value}</span>
                    </div>
                  ))}
                </div>
                <div className="rounded-lg bg-stone-50 px-2.5 py-2">
                  <SectionLabel>Accessibility notes</SectionLabel>
                  <div className="space-y-1">
                    {[
                      { type: "subway", label: "Subway/LRT", note: "Step-free via elevators (ADA/AODA compliant)" },
                      { type: "go_train", label: "GO Rail", note: "Platform accessibility varies — see station map" },
                      { type: "streetcar", label: "Streetcar", note: "Flexity Outlook has low-floor boarding" },
                      { type: "bus", label: "Bus", note: "All buses are low-floor / kneeling" },
                    ].map(({ type, label, note }) => {
                      if ((net.byMode[type] ?? 0) === 0) return null;
                      return (
                        <div key={type} className="text-[10px]">
                          <span className="font-semibold text-stone-700">{label}: </span>
                          <span className="text-stone-400">{note}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {/* ── Report ── */}
            {tab === "report" && (
              <div className="space-y-2">
                <div>
                  <SectionLabel>Select route</SectionLabel>
                  <select
                    value={reportRouteId}
                    onChange={(e) => setReportRouteId(e.target.value)}
                    className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 bg-white"
                  >
                    <option value="">— pick a route —</option>
                    {routes.filter((r) => r.stops.length >= 2).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <button
                  disabled={!reportRouteId}
                  onClick={() => {
                    const r = routes.find((x) => x.id === reportRouteId);
                    if (r) openReportTab(r, routes);
                  }}
                  className="w-full rounded-lg bg-stone-900 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Open feasibility report ↗
                </button>
                <p className="text-[10px] text-stone-400 text-center">Opens as a full document in a new tab</p>
              </div>
            )}

            {/* ── Stock ── */}
            {tab === "stock" && (
              <div className="space-y-2">
                <div>
                  <SectionLabel>Fleet type</SectionLabel>
                  <div className="flex flex-wrap gap-1">
                    {(Object.keys(ROLLING_STOCK) as (keyof typeof ROLLING_STOCK)[]).map((type) => (
                      <button
                        key={type}
                        onClick={() => setStockType(type)}
                        className={`rounded-md px-2 py-1 text-[10px] font-semibold transition-colors ${stockType === type ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}
                      >
                        {type === "go_train" ? "GO" : type.charAt(0).toUpperCase() + type.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  {ROLLING_STOCK[stockType]?.map((v, i) => (
                    <div key={i} className="rounded-lg border border-stone-100 bg-stone-50 px-2.5 py-2">
                      <p className="text-[11px] font-bold text-stone-800 leading-tight">{v.fleet}</p>
                      <div className="flex flex-wrap gap-x-3 mt-1">
                        <span className="text-[9px] text-stone-500"><span className="font-medium text-stone-600">Capacity</span> {v.capacity}</span>
                        <span className="text-[9px] text-stone-500"><span className="font-medium text-stone-600">In service</span> {v.year}</span>
                      </div>
                      <p className="text-[9px] text-stone-400 mt-0.5">{v.note}</p>
                    </div>
                  ))}
                </div>
                <p className="text-[9px] text-stone-300 text-center">Data is illustrative — verify with operator specs.</p>
              </div>
            )}

            {/* ── Station Viz ── */}
            {tab === "station" && (
              <div className="space-y-2">
                <div className="rounded-lg border border-dashed border-stone-200 bg-stone-50 px-3 py-4 text-center space-y-1">
                  <p className="text-xs font-semibold text-stone-500">Station Concept Render</p>
                  <p className="text-[10px] text-stone-400">AI-generated streetview composite with proposed station box overlay.</p>
                  <p className="text-[9px] text-stone-300 mt-1">Requires Streetview API + image generation endpoint</p>
                </div>
                <div>
                  <SectionLabel>Station type</SectionLabel>
                  <div className="flex gap-1">
                    {(["underground", "elevated", "surface"] as const).map((s) => (
                      <button
                        key={s}
                        onClick={() => setStationStyle(s)}
                        className={`flex-1 rounded-md py-1 text-[10px] font-semibold transition-colors ${stationStyle === s ? "bg-stone-900 text-white" : "bg-stone-100 text-stone-500 hover:bg-stone-200"}`}
                      >
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <SectionLabel>Location</SectionLabel>
                  <input
                    type="text"
                    placeholder="lat, lng — or click map to pick"
                    readOnly
                    className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-400 bg-stone-50 cursor-not-allowed"
                  />
                </div>
                <div className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2 space-y-1">
                  <SectionLabel>Station specs</SectionLabel>
                  {[
                    { label: "Platforms", value: stationStyle === "underground" ? "Island / side" : "Side platform" },
                    { label: "Mezzanine", value: stationStyle === "underground" ? "Below grade" : "At grade" },
                    { label: "Est. cost",  value: stationStyle === "underground" ? "$180–320M" : stationStyle === "elevated" ? "$90–150M" : "$40–80M" },
                    { label: "Timeline",  value: stationStyle === "underground" ? "5–8 years" : "3–5 years" },
                  ].map(({ label, value }) => (
                    <div key={label} className="flex justify-between text-[10px]">
                      <span className="text-stone-400">{label}</span>
                      <span className="font-semibold text-stone-700">{value}</span>
                    </div>
                  ))}
                </div>
                <button className="w-full rounded-lg border border-stone-200 px-3 py-1.5 text-xs text-stone-400 cursor-not-allowed" disabled>
                  Generate concept render →
                </button>
              </div>
            )}

            {/* ── Property ── */}
            {tab === "property" && (
              <div className="space-y-2">
                <div>
                  <SectionLabel>Select route</SectionLabel>
                  <select value={propRouteId} onChange={(e) => setPropRouteId(e.target.value)} className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 bg-white">
                    <option value="">— pick a route —</option>
                    {routes.filter((r) => r.type !== "bus" && r.type !== "streetcar").map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                {!propRoute ? (
                  <p className="text-[11px] text-stone-400 text-center py-4">Select a route to see property acquisition estimates</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <StatCard
                        label="Stations"
                        value={propRoute.stops.length}
                        sub={`× ${propRoute.type === "subway" ? "underground" : "surface"}`}
                      />
                      <StatCard
                        label="Est. land cost"
                        value={`$${(propRoute.stops.length * (propRoute.type === "subway" ? 12 : propRoute.type === "go_train" ? 25 : 4)).toFixed(0)}M`}
                        sub="rough estimate"
                      />
                    </div>
                    <div className="space-y-1 max-h-40 overflow-y-auto">
                      {propRoute.stops.map((s, i) => {
                        const isTerminus = i === 0 || i === propRoute.stops.length - 1;
                        const isPortal = propRoute.portals?.some((p) => haversineKm(p.coords, s.coords) < 0.1);
                        const landM2 = isTerminus ? 8000 : isPortal ? 5000 : 1500;
                        return (
                          <div key={s.name} className="flex items-center gap-2 rounded-lg bg-stone-50 px-2.5 py-1.5">
                            <div className="flex-1 min-w-0">
                              <p className="text-[10px] font-semibold text-stone-700 truncate">{s.name}</p>
                              <p className="text-[9px] text-stone-400">{landM2.toLocaleString()} m² · {isTerminus ? "terminus" : isPortal ? "portal" : "station"}</p>
                            </div>
                            <Pill color={isTerminus ? "bg-indigo-100 text-indigo-700" : isPortal ? "bg-amber-100 text-amber-700" : "bg-stone-100 text-stone-500"}>
                              {isTerminus ? "terminus" : isPortal ? "portal" : "station"}
                            </Pill>
                          </div>
                        );
                      })}
                    </div>
                    <p className="text-[9px] text-stone-300 text-center">Land estimates are indicative only. Consult MPAC data for actual valuation.</p>
                  </>
                )}
              </div>
            )}

            {/* Isochrone moved to the top-toolbar Layers dropdown (inline configurator). */}

            {/* ── Places ── */}
            {tab === "places" && (
              <div className="space-y-2">
                <SectionLabel>Jump to city</SectionLabel>
                <div className="grid grid-cols-2 gap-1">
                  {CITY_PRESETS.map((city) => (
                    <button
                      key={city.name}
                      onClick={() => onZoomToCity(city.lat, city.lng, city.zoom)}
                      className="rounded-lg bg-stone-50 border border-stone-100 px-2.5 py-2 text-left text-[11px] font-medium text-stone-600 hover:bg-stone-100 hover:border-stone-200 transition-colors"
                    >
                      {city.name}
                    </button>
                  ))}
                </div>
                <div className="border-t border-stone-100 pt-2 space-y-1.5">
                  <SectionLabel>Custom coords</SectionLabel>
                  <CustomCityInput onZoom={onZoomToCity} />
                </div>
              </div>
            )}

            {/* ── Cost ── */}
            {tab === "cost" && (
              <div className="space-y-2">
                <SectionLabel>Select route</SectionLabel>
                <select value={costRouteId} onChange={(e) => setCostRouteId(e.target.value)} className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 bg-white">
                  <option value="">— choose —</option>
                  {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                {costBreakdown && (
                  <>
                    <SectionLabel>Construction mix</SectionLabel>
                    <div className="space-y-1.5">
                      {([["Underground %", tunnelPct, (v: number) => setTunnelPct(Math.min(v, 100 - elevatedPct))], ["Elevated %", elevatedPct, (v: number) => setElevatedPct(Math.min(v, 100 - tunnelPct))]] as [string, number, (v: number) => void][]).map(([label, val, set]) => (
                        <div key={label}>
                          <div className="flex justify-between text-[10px] text-stone-500 mb-0.5"><span>{label}</span><span className="font-semibold">{val}%</span></div>
                          <input type="range" min={0} max={100} value={val} onChange={(e) => set(Number(e.target.value))} className="w-full accent-indigo-500" />
                        </div>
                      ))}
                      <div className="flex justify-between text-[10px] text-stone-400"><span>At-grade / surface</span><span>{costBreakdown.surfacePct}%</span></div>
                    </div>
                    <div className="rounded-lg bg-stone-50 px-2.5 py-2 space-y-1">
                      <div className="flex justify-between text-xs"><span className="text-stone-500">Route length</span><span className="font-semibold text-stone-800">{costBreakdown.totalKm.toFixed(1)} km</span></div>
                      <div className="flex justify-between text-xs"><span className="text-stone-500">Capital cost</span><span className="font-bold text-indigo-700">${costBreakdown.capitalM >= 1000 ? `${(costBreakdown.capitalM / 1000).toFixed(2)}B` : `${costBreakdown.capitalM.toFixed(0)}M`}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-stone-500">Annual operating</span><span className="font-semibold text-stone-800">~${costBreakdown.operatingM.toFixed(1)}M/yr</span></div>
                    </div>
                  </>
                )}
                {!costRouteId && <p className="text-[10px] text-stone-400 text-center py-2">Select a route to estimate costs</p>}
              </div>
            )}

            {/* ── Gaps ── */}
            {tab === "gaps" && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="Unserved centers" value={gapCenters.length} />
                  <StatCard label="Unserved pop." value={`${(gapCenters.reduce((s, c) => s + c.population, 0) / 1_000_000).toFixed(2)}M`} />
                </div>
                <SectionLabel>Highest-priority gaps</SectionLabel>
                <div className="space-y-1">
                  {gapCenters.slice(0, 8).map((c) => (
                    <div key={c.id} className="flex items-center gap-2 rounded-lg bg-rose-50 border border-rose-100 px-2.5 py-1.5">
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-stone-700 truncate">{c.name}</p>
                        <p className="text-[10px] text-stone-400">{(c.population / 1000).toFixed(0)}k residents</p>
                      </div>
                      <span className="text-[10px] font-semibold text-rose-600 shrink-0">{c.serviceRadiusKm}km</span>
                    </div>
                  ))}
                  {gapCenters.length === 0 && <p className="text-[11px] text-emerald-600 font-medium text-center py-2">All centers served!</p>}
                </div>
              </div>
            )}

            {/* ── Catchment ── */}
            {tab === "catchment" && (
              <div className="space-y-2">
                {/* Toggle moved to top-toolbar Layers dropdown. This panel keeps the advanced radius config only. */}
                <div className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[11px] ${showCatchment ? "bg-emerald-50 text-emerald-700" : "bg-stone-50 text-stone-500"}`}>
                  <span>{showCatchment ? "Catchment is ON" : "Catchment is OFF"}</span>
                  <span className="text-[10px] text-stone-400">Toggle in Layers ↑</span>
                </div>
                {showCatchment && (
                  <>
                    <SectionLabel>Catchment radius</SectionLabel>
                    <div className="flex gap-1">
                      {[400, 800, 1200].map((r) => (
                        <button key={r} onClick={() => onSetCatchmentRadius(r)} className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold transition-colors ${catchmentRadius === r ? "bg-emerald-600 border-emerald-600 text-white" : "border-stone-200 text-stone-500 hover:border-stone-300"}`}>
                          {fmtRadius(r)}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-2 pt-1">
                      <input
                        type="range"
                        min={100}
                        max={3000}
                        step={50}
                        value={catchmentRadius}
                        onChange={(e) => onSetCatchmentRadius(Number(e.target.value))}
                        className="flex-1 accent-emerald-500"
                      />
                      <div className="flex items-center gap-0.5 rounded-lg border border-stone-200 px-2 py-1">
                        <input
                          type="number"
                          min={100}
                          max={5000}
                          step={50}
                          value={catchmentRadius}
                          onChange={(e) => {
                            const v = Math.max(100, Math.min(5000, Number(e.target.value)));
                            if (!isNaN(v)) onSetCatchmentRadius(v);
                          }}
                          className="w-14 text-xs font-semibold text-stone-700 outline-none text-right bg-transparent"
                        />
                        <span className="text-[10px] text-stone-400">m</span>
                      </div>
                    </div>
                  </>
                )}
                <SectionLabel>Top stations by catchment pop.</SectionLabel>
                <div className="space-y-0.5">
                  {routes.filter((r) => !hiddenRoutes.has(r.id)).flatMap((r) => r.stops.map((s) => ({ name: s.name, route: r.shortName, pop: stationPopulations.get(s.name) ?? 0 }))).sort((a, b) => b.pop - a.pop).slice(0, 6).map((item, i) => (
                    <div key={i} className="flex items-center gap-2 py-0.5">
                      <span className="text-[10px] text-stone-300 w-3">{i + 1}</span>
                      <span className="flex-1 text-xs text-stone-600 truncate">{item.name}</span>
                      <span className="text-[10px] text-stone-400 shrink-0">{item.route}</span>
                      <span className="text-[10px] font-semibold text-stone-800 shrink-0">{item.pop > 0 ? `${(item.pop / 1000).toFixed(0)}k` : "—"}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Export ── */}
            {tab === "export" && (
              <div className="space-y-2">
                <SectionLabel>Export map image</SectionLabel>
                <div className="grid grid-cols-2 gap-1.5 mb-2">
                  <button
                    onClick={onExportMapPng}
                    className="rounded-lg border border-stone-200 px-3 py-2 text-left hover:border-stone-300 transition-colors"
                  >
                    <p className="text-xs font-semibold text-stone-700">PNG</p>
                    <p className="text-[10px] text-stone-400">Current map view</p>
                  </button>
                  <button
                    onClick={onExportMapPdf}
                    className="rounded-lg border border-stone-200 px-3 py-2 text-left hover:border-stone-300 transition-colors"
                  >
                    <p className="text-xs font-semibold text-stone-700">PDF</p>
                    <p className="text-[10px] text-stone-400">Print-ready A4</p>
                  </button>
                </div>
                <button
                  onClick={onExportSchematic}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-left hover:border-stone-300 transition-colors"
                >
                  <p className="text-xs font-semibold text-stone-700">Schematic SVG</p>
                  <p className="text-[10px] text-stone-400">Dark TTC-style line diagram</p>
                </button>
                <button
                  onClick={onCopyShareLink}
                  className="w-full rounded-lg border border-stone-200 px-3 py-2 text-left hover:border-stone-300 transition-colors mb-2"
                >
                  <p className="text-xs font-semibold text-stone-700">{shareLinkCopied ? "Link copied!" : "Copy shareable link"}</p>
                  <p className="text-[10px] text-stone-400">Encodes routes + viewport in URL</p>
                </button>
                <SectionLabel>Download network data</SectionLabel>
                {exportDone && (
                  <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-2.5 py-2 text-xs text-emerald-700 font-medium">{exportDone}</div>
                )}
                {([
                  ["Routes CSV", "route name, type, stop count, length, headway", () => {
                    const rows = ["Route,Type,Stops,LengthKm,HeadwayMin"];
                    for (const r of routes) rows.push(`"${r.name}",${r.type},${r.stops.length},${routeLengthKm(r).toFixed(1)},${parseHeadway(r.frequency, r.servicePattern)}`);
                    return [rows.join("\n"), "transit-routes.csv", "text/csv"];
                  }],
                  ["Stops CSV", "each stop with lat/lng, route, type", () => {
                    const rows = ["Stop,Lat,Lng,Route,Type"];
                    for (const r of routes) for (const s of r.stops) rows.push(`"${s.name}",${s.coords[1]},${s.coords[0]},"${r.name}","${r.type}"`);
                    return [rows.join("\n"), "transit-stops.csv", "text/csv"];
                  }],
                  ["Summary MD", "markdown network overview", () => {
                    const lines = [`# Transit Network\n**${routes.length} routes · ${routes.reduce((s, r) => s + r.stops.length, 0)} stops · ${routes.reduce((s, r) => s + routeLengthKm(r), 0).toFixed(0)} km**\n`];
                    for (const r of routes) lines.push(`## ${r.name}\n- Length: ${routeLengthKm(r).toFixed(1)} km · Stops: ${r.stops.length} · Headway: ${parseHeadway(r.frequency, r.servicePattern)} min\n- ${r.stops[0]?.name ?? "—"} → ${r.stops[r.stops.length - 1]?.name ?? "—"}\n`);
                    return [lines.join("\n"), "transit-network.md", "text/markdown"];
                  }],
                ] as [string, string, () => [string, string, string]][]).map(([label, desc, gen]) => (
                  <button key={label} onClick={() => {
                    const [content, filename, mime] = gen();
                    const a = document.createElement("a");
                    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
                    a.download = filename; a.click();
                    setExportDone(`${label} exported!`);
                    setTimeout(() => setExportDone(null), 3000);
                  }} className="w-full text-left rounded-lg border border-stone-200 px-3 py-2 hover:border-stone-300 transition-colors">
                    <p className="text-xs font-semibold text-stone-700">{label}</p>
                    <p className="text-[10px] text-stone-400">{desc}</p>
                  </button>
                ))}
              </div>
            )}

            {/* Measure moved to the top-toolbar Layers dropdown (Tools section). */}

            {/* ── Elevation ── */}
            {tab === "elevation" && (
              <div className="space-y-2">
                <SectionLabel>Select route</SectionLabel>
                <select value={elevRouteId} onChange={(e) => setElevRouteId(e.target.value)} className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 bg-white">
                  <option value="">— choose —</option>
                  {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
                {elevProfile.length > 0 && (() => {
                  const minE = Math.min(...elevProfile.map((e) => e.elev));
                  const maxE = Math.max(...elevProfile.map((e) => e.elev));
                  const range = Math.max(maxE - minE, 1);
                  return (
                    <>
                      <div className="rounded-lg bg-stone-50 px-2.5 py-2">
                        <div className="flex justify-between text-[10px] text-stone-400 mb-2">
                          <span>Elevation profile</span>
                          <span>{minE}m – {maxE}m ASL</span>
                        </div>
                        <div className="flex items-end gap-0.5 h-12">
                          {elevProfile.map((e, i) => (
                            <div key={i} className="flex-1 bg-stone-300 rounded-sm" style={{ height: `${Math.max(4, ((e.elev - minE) / range) * 100)}%` }} title={`${e.name}: ~${e.elev}m`} />
                          ))}
                        </div>
                      </div>
                      <div className="space-y-0.5 max-h-36 overflow-y-auto">
                        {elevProfile.map((e, i) => (
                          <div key={i} className="flex justify-between text-[11px] py-0.5 border-b border-stone-50">
                            <span className="text-stone-600 truncate flex-1 mr-2">{e.name || `Stop ${i + 1}`}</span>
                            <span className="text-stone-800 font-medium shrink-0">~{e.elev}m</span>
                          </div>
                        ))}
                      </div>
                      <p className="text-[9px] text-stone-300 text-center">Estimated · not surveyed data</p>
                    </>
                  );
                })()}
                {!elevRouteId && <p className="text-[10px] text-stone-400 text-center py-2">Select a route to view elevation profile</p>}
              </div>
            )}

            {/* ── Disruption ── */}
            {tab === "disruption" && (
              <div className="space-y-2">
                {/* Toggle moved to top-toolbar Layers dropdown. This panel keeps the advanced radius/route config only. */}
                <div className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-[11px] ${showDisruption ? "bg-rose-50 text-rose-700" : "bg-stone-50 text-stone-500"}`}>
                  <span>{showDisruption ? "Disruption is ON" : "Disruption is OFF"}</span>
                  <span className="text-[10px] text-stone-400">Toggle in Layers ↑</span>
                </div>
                {showDisruption && (
                  <>
                    <div>
                      <SectionLabel>Affected route</SectionLabel>
                      <select value={disruptionRouteId} onChange={(e) => onSetDisruptionRouteId(e.target.value)} className="w-full rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 bg-white">
                        <option value="">— all visible routes —</option>
                        {routes.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </div>
                    <div>
                      <SectionLabel>Buffer radius</SectionLabel>
                      <div className="flex gap-1">
                        {[100, 200, 400].map((r) => (
                          <button key={r} onClick={() => onSetDisruptionRadius(r)} className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold transition-colors ${disruptionRadius === r ? "bg-rose-600 border-rose-600 text-white" : "border-stone-200 text-stone-500 hover:border-stone-300"}`}>
                            {fmtRadius(r)}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                {(() => {
                  const affected = disruptionRouteId
                    ? routes.filter((r) => r.id === disruptionRouteId)
                    : routes.filter((r) => !hiddenRoutes.has(r.id));
                  const km = affected.reduce((s, r) => s + routeLengthKm(r), 0);
                  const stops = affected.reduce((s, r) => s + r.stops.length, 0);
                  const areaKm2 = (disruptionRadius * 2 / 1000) * km;
                  return affected.length > 0 ? (
                    <div className="rounded-lg bg-stone-50 px-2.5 py-2 space-y-1">
                      <div className="flex justify-between text-xs"><span className="text-stone-500">Corridor length</span><span className="font-semibold text-stone-800">{km.toFixed(1)} km</span></div>
                      <div className="flex justify-between text-xs"><span className="text-stone-500">Affected stations</span><span className="font-semibold text-stone-800">{stops}</span></div>
                      <div className="flex justify-between text-xs"><span className="text-stone-500">Est. impact area</span><span className="font-semibold text-rose-700">{areaKm2.toFixed(1)} km²</span></div>
                    </div>
                  ) : null;
                })()}
              </div>
            )}

            {/* ── AI Assistant ── */}
            {tab === "assistant" && (
              <div className="h-80">
                <TransitAssistant routes={routes} />
              </div>
            )}

            {/* ── Ridership ── */}
            {tab === "ridership" && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <StatCard label="Est. daily (total)" value={`${(ridershipForecasts.reduce((s, x) => s + x.daily, 0) / 1000).toFixed(0)}k`} />
                  <StatCard label="Est. annual" value={`${(ridershipForecasts.reduce((s, x) => s + x.daily, 0) * 365 / 1_000_000).toFixed(1)}M`} />
                </div>
                <SectionLabel>Top routes by forecast</SectionLabel>
                <div className="space-y-1.5">
                  {ridershipForecasts.map(({ route, daily }) => {
                    const maxD = ridershipForecasts[0]?.daily ?? 1;
                    return (
                      <div key={route.id} className="space-y-0.5">
                        <div className="flex justify-between text-[11px]">
                          <span className="text-stone-600 truncate flex-1 mr-2">{route.name}</span>
                          <span className="text-stone-800 font-semibold shrink-0">{(daily / 1000).toFixed(1)}k/day</span>
                        </div>
                        <div className="h-1 rounded-full bg-stone-100 overflow-hidden">
                          <div className="h-full rounded-full bg-indigo-400" style={{ width: `${(daily / maxD) * 100}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
                <p className="text-[9px] text-stone-300 text-center">Gravity model · illustrative only</p>
              </div>
            )}

          </div>
          )}
        </>
      )}


    </div>
  );
}

function CustomCityInput({ onZoom }: { onZoom: (lat: number, lng: number, zoom: number) => void }) {
  const [val, setVal] = useState("");
  const go = () => {
    const parts = val.split(",").map((s) => parseFloat(s.trim()));
    if (parts.length >= 2 && !isNaN(parts[0]!) && !isNaN(parts[1]!)) {
      onZoom(parts[0]!, parts[1]!, parts[2] ?? 12);
      setVal("");
    }
  };
  return (
    <div className="flex gap-1">
      <input
        type="text"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && go()}
        placeholder="lat, lng, zoom"
        className="flex-1 rounded-lg border border-stone-200 px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-stone-400 placeholder:text-stone-300"
      />
      <button onClick={go} className="rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-stone-700 transition-colors">Go</button>
    </div>
  );
}
