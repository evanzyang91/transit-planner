import "server-only";

/**
 * "What the user currently sees" — the browser sends a MapUiSnapshot with every
 * Ask AI message (layers on, map view, selection, open panels, latest
 * simulation). This module does two things with it:
 *
 *   1. sanitizeUiSnapshot — the snapshot comes from the browser, so it is
 *      UNTRUSTED and it ends up inside the model's prompt. Everything is
 *      checked against the contract's enums, numbers must be finite, lists are
 *      clamped, and strings are shortened and stripped of control characters
 *      (a route name containing "\n\nSYSTEM: ignore your rules" must not be
 *      able to start a new paragraph of instructions).
 *   2. renderUiSnapshot — turns the clean snapshot into a short prompt block.
 *      Layer ids are explained from OVERLAY_CATALOG (the client only sends ids
 *      and numbers, never prose), so "what is this heatmap?" can be answered
 *      exactly.
 *
 * 📖 Learn: "never trust the client" — anything in a request body can be
 * forged with curl, so the server validates the SHAPE (allow-lists, types,
 * ranges, sizes) before using it, even when its own front-end built it.
 */

import {
  MAP_LAYER_IDS,
  type MapLayerId,
  type MapUiSnapshot,
} from "~/lib/map-assistant-protocol";
import { describeOverlay } from "~/lib/project-knowledge";

/** Size caps (the contract's limits). Exported so tests and callers share them. */
export const SNAPSHOT_LIMITS = {
  maxStringChars: 80,
  maxIds: 50,
  maxNeighbourhoods: 20,
  maxStressRows: 5,
  maxCustomLines: 30,
} as const;

const COUNCIL_STATES = ["closed", "open", "running"] as const;

// Row types pulled out of the contract, so the sanitisers can build arrays of them.
type CustomLine = NonNullable<NonNullable<MapUiSnapshot["network"]>["customLines"]>[number];
type StressRow = NonNullable<NonNullable<MapUiSnapshot["simulation"]>["topStress"]>[number];

// ── Small coercions ───────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

function asObject(raw: unknown): Obj | null {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Obj) : null;
}

/**
 * Characters with no business inside a name: C0/C1 control characters (incl.
 * newlines and tabs), zero-width characters and bidirectional overrides (which
 * can make text display differently from what the model reads).
 * 📖 Learn: Unicode "bidi override" characters (U+202A–U+202E, U+2066–U+2069)
 * reorder how text is DISPLAYED without changing the underlying characters.
 */
const UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g;

/** A short, single-line, printable string — or null when nothing usable is left. */
function cleanString(raw: unknown, maxChars: number = SNAPSHOT_LIMITS.maxStringChars): string | null {
  if (typeof raw !== "string") return null;
  const singleLine = raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (singleLine === "") return null;
  // Array.from splits by code point, so an emoji is never cut in half.
  const chars = Array.from(singleLine);
  return chars.length > maxChars ? chars.slice(0, maxChars).join("") : singleLine;
}

/** Strings that may legitimately be null in the contract ("nothing selected"). */
function cleanNullableString(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  // cleanString returns null for "nothing usable"; here that means "not sent" (undefined).
  return cleanString(raw) ?? undefined;
}

function cleanNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/** A finite number forced into [min, max]. */
function cleanClamped(raw: unknown, min: number, max: number): number | undefined {
  const n = cleanNumber(raw);
  return n === undefined ? undefined : Math.min(max, Math.max(min, n));
}

/** A non-negative whole number (counts). */
function cleanCount(raw: unknown, max = 1_000_000): number | undefined {
  const n = cleanNumber(raw);
  return n === undefined || n < 0 ? undefined : Math.min(max, Math.round(n));
}

function cleanBool(raw: unknown): boolean | undefined {
  return typeof raw === "boolean" ? raw : undefined;
}

/** A de-duplicated list of short strings, at most `max` long. */
function cleanStringList(raw: unknown, max: number): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw) {
    if (out.length >= max) break;
    const s = cleanString(item);
    if (s !== null && !out.includes(s)) out.push(s);
  }
  return out;
}

function isLayerId(value: unknown): value is MapLayerId {
  return typeof value === "string" && (MAP_LAYER_IDS as readonly string[]).includes(value);
}

/** Drop keys whose value is undefined, so the sanitized object only has real fields. */
function compact<T extends Obj>(obj: T): T {
  const out: Obj = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

// ── Section sanitisers ────────────────────────────────────────────────────────

function sanitizeViewport(raw: unknown): MapUiSnapshot["viewport"] {
  const o = asObject(raw);
  if (!o) return undefined;

  const center = Array.isArray(o.center) ? o.center : [];
  const lng = cleanNumber(center[0]);
  const lat = cleanNumber(center[1]);
  const zoom = cleanClamped(o.zoom, 0, 24);
  const bounds = Array.isArray(o.bounds) ? o.bounds.slice(0, 4).map(cleanNumber) : [];
  const boundsOk = bounds.length === 4 && bounds.every((n) => n !== undefined);

  // The camera is only useful whole — a centre without a zoom can't be described.
  if (lng === undefined || lat === undefined || zoom === undefined || !boundsOk) return undefined;
  if (Math.abs(lng) > 180 || Math.abs(lat) > 90) return undefined;

  return compact({
    center: [lng, lat] as [number, number],
    zoom,
    bounds: bounds as [number, number, number, number],
    neighbourhoodAtCenter: cleanNullableString(o.neighbourhoodAtCenter),
  });
}

function sanitizeLayers(raw: unknown): MapUiSnapshot["layers"] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<MapLayerId>();
  const out: MapUiSnapshot["layers"] = [];
  for (const item of raw) {
    const o = asObject(item);
    if (!o || !isLayerId(o.id) || typeof o.on !== "boolean") continue;
    if (seen.has(o.id)) continue; // first report of a layer wins
    seen.add(o.id);
    out.push(
      compact({
        id: o.id,
        on: o.on,
        loading: cleanBool(o.loading),
        detail: cleanString(o.detail) ?? undefined,
      }),
    );
  }
  return out;
}

function sanitizeSelection(raw: unknown): MapUiSnapshot["selection"] {
  const o = asObject(raw);
  if (!o) return undefined;
  const selection = compact({
    routeId: cleanNullableString(o.routeId),
    routeName: cleanNullableString(o.routeName),
    stopName: cleanNullableString(o.stopName),
    neighbourhood: cleanNullableString(o.neighbourhood),
    selectedNeighbourhoods: cleanStringList(o.selectedNeighbourhoods, SNAPSHOT_LIMITS.maxNeighbourhoods),
  });
  return Object.keys(selection).length > 0 ? selection : undefined;
}

function sanitizePanels(raw: unknown): MapUiSnapshot["panels"] {
  const o = asObject(raw);
  if (!o) return undefined;
  const council = (COUNCIL_STATES as readonly string[]).includes(o.council as string)
    ? (o.council as (typeof COUNCIL_STATES)[number])
    : undefined;
  const panels = compact({
    simulation: cleanBool(o.simulation),
    plans: cleanBool(o.plans),
    analysis: cleanBool(o.analysis),
    routePanel: cleanBool(o.routePanel),
    council,
  });
  return Object.keys(panels).length > 0 ? panels : undefined;
}

function sanitizeNetwork(raw: unknown): MapUiSnapshot["network"] {
  const o = asObject(raw);
  if (!o) return undefined;

  // undefined = the client didn't report custom lines; [] = it reported none.
  let customLines: CustomLine[] | undefined;
  if (Array.isArray(o.customLines)) {
    customLines = [];
    for (const item of o.customLines) {
      if (customLines.length >= SNAPSHOT_LIMITS.maxCustomLines) break;
      const line = asObject(item);
      const id = cleanString(line?.id);
      const name = cleanString(line?.name);
      if (!line || id === null || name === null) continue;
      customLines.push({
        id,
        name,
        type: cleanString(line.type, 20) ?? "line",
        stops: cleanCount(line.stops, 10_000) ?? 0,
      });
    }
  }

  const network = compact({
    hiddenRouteIds: cleanStringList(o.hiddenRouteIds, SNAPSHOT_LIMITS.maxIds),
    customLines,
    busRoutesLoaded: cleanCount(o.busRoutesLoaded, 10_000),
    goTransit: cleanBool(o.goTransit),
    planName: cleanNullableString(o.planName),
    unsavedChanges: cleanBool(o.unsavedChanges),
  });
  return Object.keys(network).length > 0 ? network : undefined;
}

function sanitizeSimulation(raw: unknown): MapUiSnapshot["simulation"] {
  if (raw === null) return null;
  const o = asObject(raw);
  if (!o) return undefined;
  const scenario = cleanString(o.scenario);
  const agents = cleanCount(o.agents, 100_000);
  // Without these two the summary can't be described — treat as "no result".
  if (scenario === null || agents === undefined) return undefined;

  const topStress: StressRow[] = [];
  if (Array.isArray(o.topStress)) {
    for (const item of o.topStress) {
      if (topStress.length >= SNAPSHOT_LIMITS.maxStressRows) break;
      const row = asObject(item);
      const from = cleanString(row?.from);
      const to = cleanString(row?.to);
      const stressPct = cleanNumber(row?.stressPct);
      if (!row || from === null || to === null || stressPct === undefined) continue;
      topStress.push(
        compact({
          line: cleanString(row.line) ?? undefined,
          from,
          to,
          stressPct,
          deltaPct: cleanNumber(row.deltaPct),
        }),
      );
    }
  }

  return compact({
    scenario,
    agents,
    baselinePctAccessible: cleanNumber(o.baselinePctAccessible),
    scenarioPctAccessible: cleanNumber(o.scenarioPctAccessible),
    timeSavedMin: cleanNumber(o.timeSavedMin),
    newlyAccessible: cleanNumber(o.newlyAccessible),
    equityImprovement: cleanNumber(o.equityImprovement),
    topStress: topStress.length > 0 ? topStress : undefined,
  });
}

function sanitizePrefs(raw: unknown): MapUiSnapshot["prefs"] {
  const o = asObject(raw);
  if (!o) return undefined;
  const prefs = compact({ dark: cleanBool(o.dark), imperial: cleanBool(o.imperial) });
  return Object.keys(prefs).length > 0 ? prefs : undefined;
}

/**
 * Validate an untrusted snapshot from the request body.
 * Returns null when it is missing, not an object, or a different version
 * (so the prompt says "UI state unknown" instead of trusting a shape it
 * doesn't understand).
 */
export function sanitizeUiSnapshot(raw: unknown): MapUiSnapshot | null {
  const o = asObject(raw);
  // 📖 Learn: optional chaining narrowing — `o?.v` is undefined when o is null,
  // so this one check covers "not an object" AND "wrong version", and after it
  // TypeScript knows `o` is not null.
  if (o?.v !== 1) return null;

  return compact({
    v: 1 as const,
    viewport: sanitizeViewport(o.viewport),
    layers: sanitizeLayers(o.layers),
    selection: sanitizeSelection(o.selection),
    panels: sanitizePanels(o.panels),
    network: sanitizeNetwork(o.network),
    simulation: sanitizeSimulation(o.simulation),
    prefs: sanitizePrefs(o.prefs),
    signedIn: cleanBool(o.signedIn),
  });
}

// ── Renderer ──────────────────────────────────────────────────────────────────

/** What the prompt says when the browser sent nothing usable. */
export const UI_STATE_UNKNOWN =
  "UI state unknown — the app did not report what is on screen. Don't guess which layers are visible; if it matters, describe the likely candidates.";

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/** Signed number for deltas: "+3.2" / "−1.5" / "0". */
function signed(n: number): string {
  const r = round(n, 1);
  if (r > 0) return `+${r}`;
  if (r < 0) return `−${Math.abs(r)}`;
  return "0";
}

function describeZoom(zoom: number): string {
  if (zoom < 11) return "whole-city view";
  if (zoom < 13) return "district view";
  if (zoom < 15) return "neighbourhood view";
  return "street-level view";
}

/** Ids like "bus-7" are TTC bus routes (transit-data.ts naming); everything else is named individually. */
function isBusRouteId(id: string): boolean {
  return id.startsWith("bus-");
}

/**
 * The snapshot as a compact prompt block (a few hundred tokens). Only states
 * what is ON / open / selected — the absence of a line means "off / none".
 */
export function renderUiSnapshot(ui: MapUiSnapshot | null): string {
  if (!ui) return UI_STATE_UNKNOWN;
  const lines: string[] = [];

  // Camera — the bbox lets the model scope tools to "this area" / "what I'm looking at".
  if (ui.viewport) {
    const { center, zoom, bounds, neighbourhoodAtCenter } = ui.viewport;
    const where = neighbourhoodAtCenter
      ? `centred on ${neighbourhoodAtCenter}`
      : `centred on [${round(center[0], 4)}, ${round(center[1], 4)}]`;
    const bbox = bounds.map((n) => round(n, 4)).join(", ");
    lines.push(`Map view: ${where}, zoom ${round(zoom, 1)} (${describeZoom(zoom)}); visible bbox [${bbox}].`);
  }

  // Layers — explained from the catalogue so the answer to "what is this
  // heatmap?" is grounded in what the layer actually computes.
  const visible = ui.layers.filter((l) => l.on || l.loading);
  if (visible.length === 0) {
    lines.push("Overlays ON: none (base map and transit lines only).");
  } else {
    lines.push("Overlays ON (every other overlay is off):");
    for (const layer of visible) {
      const status = layer.on ? "" : " (switching on…)";
      const loading = layer.on && layer.loading ? " (still loading)" : "";
      const detail = layer.detail ? ` Current setting: ${layer.detail}.` : "";
      lines.push(`- ${describeOverlay(layer.id)}${status}${loading}${detail}`);
    }
  }

  // Selection.
  const sel = ui.selection;
  if (sel) {
    if (sel.routeName || sel.routeId) {
      const name = sel.routeName ?? sel.routeId;
      const id = sel.routeId && sel.routeId !== name ? ` (id ${sel.routeId})` : "";
      lines.push(`Selected line: ${name}${id}.`);
    }
    if (sel.stopName) lines.push(`Selected stop: ${sel.stopName}.`);
    if (sel.neighbourhood) lines.push(`Neighbourhood panel open for: ${sel.neighbourhood}.`);
    if (sel.selectedNeighbourhoods && sel.selectedNeighbourhoods.length > 0) {
      lines.push(
        `Neighbourhoods selected for the council (${sel.selectedNeighbourhoods.length}): ${sel.selectedNeighbourhoods.join(", ")}.`,
      );
    }
  }

  // Panels.
  const p = ui.panels;
  if (p) {
    const open: string[] = [];
    if (p.simulation) open.push("Simulate");
    if (p.plans) open.push("Plans");
    if (p.analysis) open.push("Analysis");
    if (p.routePanel) open.push("Route panel");
    if (p.council === "open") open.push("Council");
    if (p.council === "running") open.push("Council (debate running)");
    lines.push(`Open panels: ${open.length > 0 ? open.join(", ") : "none"}.`);
  }

  // Network / plan.
  const n = ui.network;
  if (n) {
    if (n.planName || n.unsavedChanges !== undefined) {
      const plan = n.planName ? `saved plan "${n.planName}"` : "no saved plan loaded";
      const dirty = n.unsavedChanges ? ", with unsaved changes" : "";
      lines.push(`Plan: ${plan}${dirty}.`);
    }
    if (n.customLines && n.customLines.length > 0) {
      const list = n.customLines.map((c) => `${c.name} (${c.type}, ${c.stops} stops)`).join("; ");
      lines.push(`Custom lines (${n.customLines.length}): ${list}.`);
    }
    if (n.hiddenRouteIds && n.hiddenRouteIds.length > 0) {
      // Every TTC bus route starts hidden and the id list is capped, so a bus
      // COUNT would mislead; name the other hidden lines, mention buses only.
      const named = n.hiddenRouteIds.filter((id) => !isBusRouteId(id));
      const anyBus = named.length < n.hiddenRouteIds.length;
      const busNote = "TTC bus routes (bus routes start hidden)";
      if (named.length === 0) {
        lines.push(`Hidden lines: only ${busNote}.`);
      } else {
        const shown = named.slice(0, 10).join(", ") + (named.length > 10 ? ` +${named.length - 10} more` : "");
        lines.push(`Hidden lines: ${shown}${anyBus ? `; plus ${busNote}` : ""}.`);
      }
    }
    if (n.busRoutesLoaded !== undefined) {
      lines.push(
        `Bus routes loaded into the plan: ${n.busRoutesLoaded} (TTC bus routes that are not loaded are not counted by any measure).`,
      );
    }
    if (n.goTransit !== undefined) lines.push(`GO Transit lines: ${n.goTransit ? "on" : "off"}.`);
  }

  // Latest simulation result.
  const sim = ui.simulation;
  if (sim) {
    const parts = [`"${sim.scenario}", ${sim.agents} agents`];
    if (sim.baselinePctAccessible !== undefined) {
      const after = sim.scenarioPctAccessible !== undefined ? ` → ${round(sim.scenarioPctAccessible, 1)}%` : "";
      parts.push(`transit-accessible ${round(sim.baselinePctAccessible, 1)}%${after}`);
    }
    if (sim.timeSavedMin !== undefined) parts.push(`time saved ${signed(sim.timeSavedMin)} min per trip`);
    if (sim.newlyAccessible !== undefined) parts.push(`newly accessible ${round(sim.newlyAccessible, 0)}`);
    if (sim.equityImprovement !== undefined) parts.push(`equity ${signed(sim.equityImprovement)} points`);
    lines.push(`Latest simulation (Simulate panel): ${parts.join("; ")}.`);
    if (sim.topStress && sim.topStress.length > 0) {
      const rows = sim.topStress.map((r) => {
        const line = r.line ? `${r.line}: ` : "";
        const delta = r.deltaPct !== undefined ? `, change ${signed(r.deltaPct)}` : "";
        return `${line}${r.from} → ${r.to} ${round(r.stressPct, 1)}%${delta}`;
      });
      lines.push(`Most stressed segments: ${rows.join("; ")}.`);
    }
  } else if (sim === null) {
    lines.push("Simulation: no results on screen.");
  }

  // Preferences that change how to answer.
  if (ui.prefs?.imperial) lines.push("Units: the user prefers imperial — give distances in miles too.");
  if (ui.signedIn !== undefined) lines.push(`Signed in: ${ui.signedIn ? "yes" : "no (Plans needs sign-in)"}.`);

  return lines.join("\n");
}
