/**
 * "What the user can see right now", turned into the small MapUiSnapshot the
 * Ask AI assistant receives with every message (see ~/lib/map-assistant-protocol.ts).
 *
 * Why a separate, pure module: TransitMap.tsx owns ~100 pieces of UI state. It
 * copies the relevant ones into a plain `MapUiStateInput` object at send time,
 * and everything else — which layers count as "on", rounding, caps, the
 * simulation summary — happens here, where it can be unit-tested without a
 * browser or a Mapbox map.
 *
 * Rule for this file: ids, enums and numbers only. Anything that reads like a
 * sentence would end up inside the model's prompt, so it is left out (the
 * server explains each layer id from its own catalog). Names (lines, stops,
 * neighbourhoods) are the one exception, because "which line is selected" is
 * meaningless without them — they are length-capped instead.
 */

import type { MapLayerId, MapUiSnapshot } from "~/lib/map-assistant-protocol";
import type { SimulationResult } from "./SimulationPanel";
import { pointInGeometry } from "./geo";

// ── Input: a plain copy of TransitMap state ──────────────────────────────────

/** Field names mirror the TransitMap state they are copied from, so the copy is boring on purpose. */
export interface MapUiStateInput {
  /** Camera, read from the Mapbox instance at call time. null while the map/style is (re)loading. */
  viewport: {
    center: [number, number];
    zoom: number;
    /** [west, south, east, north] */
    bounds: [number, number, number, number];
    /** null = outside every Toronto neighbourhood; undefined = boundaries not loaded yet. */
    neighbourhoodAtCenter?: string | null;
  } | null;

  // Overlays (the Layers dropdown + the simulation layers)
  showHeatmap: boolean;
  popLoading: boolean;
  showCanadaPop: boolean;
  canadaPopLoading: boolean;
  showServiceHeatmap: boolean;
  showTransitDesert: boolean;
  desertComputing: boolean;
  showTraffic: boolean;
  trafficLoading: boolean;
  showCoverageZones: boolean;
  showCatchment: boolean;
  catchmentRadius: number;
  showDisruption: boolean;
  disruptionRadius: number;
  isochrone: { origin: [number, number] | null; minutes: number; mode: string };
  showLiveVehicles: boolean;
  showStationLabels: boolean;
  aiFindingsVisible: boolean;
  aiFindingsCount: number;
  customOverlayLoaded: boolean;
  /** Distinct commuters in the running agent animation (0 = animation off). */
  animatedAgentCount: number;

  // Selection
  selectedRoute: { id: string; name: string } | null;
  selectedStopName: string | null;
  focusedNeighbourhood: string | null;
  selectedNeighbourhoods: string[];

  // Panels — "visible" means actually on screen (the Route panel hides Simulate/Plans).
  simPanelVisible: boolean;
  plansPanelVisible: boolean;
  analysisPanelOpen: boolean;
  councilOpen: boolean;
  councilRunning: boolean;

  // Network
  /** Route[] fits this shape, so TransitMap can pass its `routes` state directly. */
  routes: ReadonlyArray<{ id: string; name: string; type: string; stops: readonly unknown[] }>;
  hiddenRouteIds: ReadonlySet<string>;
  goTransit: boolean;
  unsavedChanges: boolean;

  /** The latest Simulate result (SimulationResult) or null. Typed unknown because it may come off the wire. */
  simResults: unknown;

  darkMode: boolean;
  imperial: boolean;
  signedIn: boolean;
}

// ── Caps (keep the snapshot a few hundred bytes, not kilobytes) ──────────────

const MAX_NAME_CHARS = 60;
const MAX_CUSTOM_LINES = 40;
const MAX_HIDDEN_IDS = 60;
const MAX_SELECTED_NEIGHBOURHOODS = 20;
const TOP_STRESS_SEGMENTS = 5;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function capText(text: string, maxChars = MAX_NAME_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1)}…` : trimmed;
}

// ── Builder ──────────────────────────────────────────────────────────────────

type SnapshotLayer = MapUiSnapshot["layers"][number];

export function buildMapUiSnapshot(input: MapUiStateInput): MapUiSnapshot {
  const snapshot: MapUiSnapshot = { v: 1, layers: buildLayers(input) };

  if (input.viewport) {
    const { center, zoom, bounds, neighbourhoodAtCenter } = input.viewport;
    snapshot.viewport = {
      // 5 decimals ≈ 1 m — more precision is just noise in the prompt.
      center: [roundTo(center[0], 5), roundTo(center[1], 5)],
      zoom: roundTo(zoom, 2),
      bounds: [roundTo(bounds[0], 5), roundTo(bounds[1], 5), roundTo(bounds[2], 5), roundTo(bounds[3], 5)],
    };
    if (neighbourhoodAtCenter !== undefined) {
      snapshot.viewport.neighbourhoodAtCenter = neighbourhoodAtCenter === null ? null : capText(neighbourhoodAtCenter);
    }
  }

  const selection = buildSelection(input);
  if (selection) snapshot.selection = selection;

  snapshot.panels = {
    simulation: input.simPanelVisible,
    plans: input.plansPanelVisible,
    analysis: input.analysisPanelOpen,
    routePanel: input.selectedRoute !== null,
    council: input.councilRunning ? "running" : input.councilOpen ? "open" : "closed",
  };

  snapshot.network = buildNetwork(input);
  snapshot.simulation = summarizeSimulation(input.simResults);
  snapshot.prefs = { dark: input.darkMode, imperial: input.imperial };
  snapshot.signedIn = input.signedIn;
  return snapshot;
}

/**
 * Only layers that are ON are listed ("not listed = off", per the protocol),
 * in MAP_LAYER_IDS order so the output is deterministic.
 */
function buildLayers(input: MapUiStateInput): SnapshotLayer[] {
  const layers: SnapshotLayer[] = [];

  function addIfOn(id: MapLayerId, on: boolean, extra: { loading?: boolean; detail?: string } = {}) {
    if (!on) return;
    const layer: SnapshotLayer = { id, on: true };
    // A loading flag only matters for a layer the user switched on — popLoading,
    // for example, is true at startup even while the heatmap is off.
    if (extra.loading) layer.loading = true;
    if (extra.detail) layer.detail = extra.detail;
    layers.push(layer);
  }

  addIfOn("population", input.showHeatmap, { loading: input.popLoading });
  addIfOn("canadaPop", input.showCanadaPop, { loading: input.canadaPopLoading });
  addIfOn("serviceHeatmap", input.showServiceHeatmap);
  addIfOn("transitDesert", input.showTransitDesert, { loading: input.desertComputing });
  addIfOn("traffic", input.showTraffic, { loading: input.trafficLoading });
  addIfOn("coverage", input.showCoverageZones);
  addIfOn("catchment", input.showCatchment, { detail: `${Math.round(input.catchmentRadius)} m` });
  addIfOn("disruption", input.showDisruption, { detail: `${Math.round(input.disruptionRadius)} m` });
  addIfOn("isochrone", input.isochrone.origin !== null, {
    detail: `${input.isochrone.minutes} min ${input.isochrone.mode}`,
  });
  addIfOn("liveVehicles", input.showLiveVehicles);
  addIfOn("stationLabels", input.showStationLabels);
  // Same rule as the "AI findings" row in the Layers dropdown: on = visible AND something to show.
  addIfOn("aiFindings", input.aiFindingsVisible && input.aiFindingsCount > 0, {
    detail: `${input.aiFindingsCount} annotation${input.aiFindingsCount === 1 ? "" : "s"}`,
  });
  addIfOn("customOverlay", input.customOverlayLoaded);

  const simulation = isSimulationResultLike(input.simResults) ? input.simResults : null;
  const stressSegments = simulation ? simulation.line_stress.length + simulation.baseline_edge_stress.length : 0;
  // TransitMap only draws the stress layers when there is at least one segment.
  addIfOn("simStress", stressSegments > 0);
  addIfOn("simAgents", input.animatedAgentCount > 0, { detail: `${input.animatedAgentCount} agents` });

  return layers;
}

function buildSelection(input: MapUiStateInput): MapUiSnapshot["selection"] | undefined {
  const selection: NonNullable<MapUiSnapshot["selection"]> = {};
  if (input.selectedRoute) {
    selection.routeId = input.selectedRoute.id;
    selection.routeName = capText(input.selectedRoute.name);
  }
  if (input.selectedStopName) selection.stopName = capText(input.selectedStopName);
  if (input.focusedNeighbourhood) selection.neighbourhood = capText(input.focusedNeighbourhood);
  if (input.selectedNeighbourhoods.length > 0) {
    selection.selectedNeighbourhoods = input.selectedNeighbourhoods
      .slice(0, MAX_SELECTED_NEIGHBOURHOODS)
      .map((name) => capText(name));
  }
  // Nothing selected → leave the whole block out (absence already says "nothing selected").
  return Object.keys(selection).length > 0 ? selection : undefined;
}

function buildNetwork(input: MapUiStateInput): NonNullable<MapUiSnapshot["network"]> {
  // hiddenRoutes starts out holding all ~200 TTC bus ids (buses are hidden
  // until activated). Only lines that are actually in the plan are worth
  // reporting — "bus 132 is hidden" is noise when bus 132 isn't loaded.
  const hiddenRouteIds = input.routes
    .filter((route) => input.hiddenRouteIds.has(route.id))
    .map((route) => route.id)
    .slice(0, MAX_HIDDEN_IDS);

  const customLines = input.routes
    .filter((route) => route.id.startsWith("custom-"))
    .slice(0, MAX_CUSTOM_LINES)
    .map((route) => ({ id: route.id, name: capText(route.name), type: route.type, stops: route.stops.length }));

  return {
    hiddenRouteIds,
    customLines,
    busRoutesLoaded: input.routes.filter((route) => route.type === "bus").length,
    goTransit: input.goTransit,
    unsavedChanges: input.unsavedChanges,
    // planName is not reported: the plan's name lives inside PlansPanel, and
    // TransitMap only knows the plan id.
  };
}

// ── Simulation result: guard + compact summary ───────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isLngLat(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

function isRunStats(value: unknown): boolean {
  return isRecord(value) && isFiniteNumber(value.pct_accessible) && isRecord(value.income_breakdown);
}

function isStressSegment(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.from_stop === "string" &&
    typeof value.to_stop === "string" &&
    isLngLat(value.from_coords) &&
    isLngLat(value.to_coords) &&
    isFiniteNumber(value.stress_pct) &&
    isFiniteNumber(value.delta_pct)
  );
}

/**
 * Checks that an unknown value has every field the Simulate panel and the
 * map's stress/agent layers read without a null check. A result that arrives
 * through the chat (show_simulation) is untrusted input: if a field were
 * missing, `result.delta.total_time_saved_min.toFixed(1)` would crash the map.
 *
 * 📖 Learn: "type predicate" — the `value is SimulationResult` return type
 * tells TypeScript that after `if (isSimulationResultLike(x))`, x is a
 * SimulationResult inside that branch.
 */
export function isSimulationResultLike(value: unknown): value is SimulationResult {
  if (!isRecord(value)) return false;
  const { delta, equity, time_range: timeRange } = value;
  return (
    typeof value.scenario_name === "string" &&
    isFiniteNumber(value.agent_count) &&
    isFiniteNumber(value.animated_agent_count) &&
    typeof value.has_proposed_lines === "boolean" &&
    isRunStats(value.baseline) &&
    isRunStats(value.scenario) &&
    isRecord(delta) &&
    isFiniteNumber(delta.total_time_saved_min) &&
    isFiniteNumber(delta.newly_accessible_agents) &&
    isFiniteNumber(delta.equity_improvement) &&
    isRecord(equity) &&
    isFiniteNumber(equity.baseline_score) &&
    isFiniteNumber(equity.scenario_score) &&
    isRecord(timeRange) &&
    isFiniteNumber(timeRange.start_min) &&
    isFiniteNumber(timeRange.end_min) &&
    Array.isArray(value.line_stress) &&
    value.line_stress.every(isStressSegment) &&
    Array.isArray(value.baseline_edge_stress) &&
    value.baseline_edge_stress.every(isStressSegment) &&
    Array.isArray(value.per_agent) &&
    value.per_agent.every((agent) => isRecord(agent) && Array.isArray(agent.path_coords))
  );
}

/** Numbers the assistant needs to talk about the latest run — no per-agent data. */
export function summarizeSimulation(result: unknown): MapUiSnapshot["simulation"] {
  if (!isSimulationResultLike(result)) return null;

  const summary: NonNullable<MapUiSnapshot["simulation"]> = {
    scenario: capText(result.scenario_name),
    agents: result.agent_count,
    baselinePctAccessible: roundTo(result.baseline.pct_accessible, 1),
  };

  // A baseline-only run has no scenario to compare against; its "delta" fields
  // are all zero, and reporting "0 minutes saved" would invite a wrong reading.
  if (result.has_proposed_lines) {
    summary.scenarioPctAccessible = roundTo(result.scenario.pct_accessible, 1);
    // The panel's "Time saved · min avg" tile shows total_time_saved_min, so we report the same number.
    summary.timeSavedMin = roundTo(result.delta.total_time_saved_min, 1);
    summary.newlyAccessible = result.delta.newly_accessible_agents;
    summary.equityImprovement = roundTo(result.delta.equity_improvement, 1);
  }

  // Same merge as the panel's Stress tab: new-line and existing segments on one scale.
  const allSegments = [...result.line_stress, ...result.baseline_edge_stress];
  const busiestFirst = [...allSegments].sort((a, b) => b.stress_pct - a.stress_pct);
  summary.topStress = busiestFirst.slice(0, TOP_STRESS_SEGMENTS).map((segment) => {
    const row: NonNullable<NonNullable<MapUiSnapshot["simulation"]>["topStress"]>[number] = {
      from: capText(segment.from_stop),
      to: capText(segment.to_stop),
      stressPct: Math.round(segment.stress_pct),
      deltaPct: Math.round(segment.delta_pct),
    };
    if (segment.line_name) row.line = capText(segment.line_name);
    return row;
  });

  return summary;
}

// ── Network payload (the same shape TransitAssistant used to build) ─────────

/** Live routes for the server tools: ids, names, badges, types and stop coordinates — no colours or shapes. */
export function toNetworkRoutesPayload(
  routes: ReadonlyArray<{
    id: string;
    name: string;
    shortName?: string;
    type: string;
    stops: ReadonlyArray<{ name: string; coords: [number, number] }>;
  }>,
): Array<{
  id: string;
  name: string;
  shortName?: string;
  type: string;
  stops: Array<{ name: string; coords: [number, number] }>;
}> {
  return routes.map((route) => ({
    id: route.id,
    name: route.name,
    // The badge ("1", "504", a custom line's auto badge). The server's
    // buildNetwork reads it to show "Line 1 Yonge-University" in the prompt and
    // to match "the 504" — without it the live map looked different from the
    // default network the server falls back to (which has badges).
    ...(route.shortName ? { shortName: route.shortName } : {}),
    type: route.type,
    stops: route.stops.map((stop) => ({ name: stop.name, coords: stop.coords })),
  }));
}

// ── Neighbourhood lookups (Toronto's 158 neighbourhood boundaries) ───────────

/** The bits of a GeoJSON Feature we read. A GeoJSON.Feature fits this shape. */
export interface NeighbourhoodFeatureLike {
  properties: Record<string, unknown> | null;
  geometry: GeoJSON.Geometry | null;
}

function featureName(feature: NeighbourhoodFeatureLike): string | null {
  const name = feature.properties?.AREA_NAME;
  return typeof name === "string" ? name : null;
}

/** Name of the neighbourhood that contains `point` ([lng, lat]), or null when none does. */
export function neighbourhoodNameAt(
  point: [number, number],
  features: readonly NeighbourhoodFeatureLike[],
): string | null {
  for (const feature of features) {
    if (feature.geometry && pointInGeometry(point, feature.geometry)) return featureName(feature);
  }
  return null;
}

/**
 * Comparison key for neighbourhood names: lower-case, without a trailing
 * " (123)" code, keeping only letters and digits. So "Yonge Bay Corridor",
 * "yonge-bay corridor" and "Yonge-Bay Corridor (170)" all match.
 */
export function neighbourhoodNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(\d+\)\s*$/, "")
    .replace(/[^a-z0-9]/g, "");
}

/** The boundary feature whose AREA_NAME matches `name` (loosely), or null. */
export function findNeighbourhoodByName<F extends NeighbourhoodFeatureLike>(
  features: readonly F[],
  name: string,
): F | null {
  const wanted = neighbourhoodNameKey(name);
  if (!wanted) return null;
  for (const feature of features) {
    const candidate = featureName(feature);
    if (candidate && neighbourhoodNameKey(candidate) === wanted) return feature;
  }
  return null;
}
