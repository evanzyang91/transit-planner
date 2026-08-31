"use client";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import mapboxgl from "mapbox-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { haversineKm, computeStationPopulations } from "~/app/map/geo-utils";
import {
  ROUTES,
  BUS_ROUTES,
  GO_TRAIN_ROUTES,
  PEDESTRIAN_CONNECTIONS,
  type GeneratedRoute,
  type Route,
} from "~/app/map/transit-data";
import { routeToGeoJSON, stopsToGeoJSON, geomBBox, portalsToGeoJSON, undergroundToGeoJSON, snapToShape, sliceShapeBetween, pointInGeometry } from "./map/geo";
import { newStopId, withStopIds, transferCounterparts, transferExclusionKey } from "~/app/map/stop-identity";
import { NeighbourhoodPanel } from "./map/NeighbourhoodPanel";
import { RoutePanel } from "./map/RoutePanel";
import { GeneratedRoutePanel } from "./map/GeneratedRoutePanel";
import { StationPopup } from "./map/StationPopup";
import { NewLineModal } from "./map/NewLineModal";
import { ExperimentalPanel } from "./map/ExperimentalPanel";
import { LayersDropdown, type OverlaySpec, type ActionRow } from "./map/LayersDropdown";
import { OVERLAY_ICONS } from "./map/overlay-icons";
import { IsochroneDetails } from "./map/IsochroneDetails";
import { AIChatPanel } from "./map/AIChatPanel";
import {
  annotationBbox,
  useAIAnnotations,
  editableVertices,
  moveVertex,
  insertVertex,
  deleteVertex,
  type AIAnnotation,
} from "./map/AIAnnotationsContext";
import { COLOR_HEX } from "~/lib/ai-map-tools-client";
import LinesPanel from "./map/LinesPanel";
import { GameMode } from "./map/GameMode";
import { MobileNav } from "./MobileNav";
import { ChangelogModal } from "./map/ChangelogModal";
import { FeedbackModal } from "./map/FeedbackModal";
import { ChatPanel, type ParsedRoute, type ToolCallEvent } from "./ChatPanel";
import { SimulationPanel, type SimulationResult } from "./map/SimulationPanel";
import { PlansPanel } from "./map/PlansPanel";
import { useUser } from "@auth0/nextjs-auth0/client";
import Image from "next/image";
import { useOverlay } from "./map/hooks/useOverlay";
import { useTraffic } from "./map/hooks/useTraffic";
import { useHeatmap } from "./map/hooks/useHeatmap";
import { useLiveVehicles } from "./map/hooks/useLiveVehicles";
import { useTransitDesert } from "./map/hooks/useTransitDesert";
import { useIsochrone } from "./map/hooks/useIsochrone";
import { identifyAnalyticsUser, registerAnalyticsSuperProps, trackEvent } from "~/lib/analytics";

type DrawMode = "normal" | "select" | "boundary";

/** One undo/redo entry. Everything the user can change and expect to get back. */
type HistoryState = {
  routes: Route[];
  counter: number;
  transferExclusions: Set<string>;
};
type RouteMetrics = {
  total_lines: number;
  total_stations: number;
  total_portals: number;
  custom_lines: number;
  subway_lines: number;
  streetcar_lines: number;
  bus_lines: number;
};

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

const TORONTO: [number, number] = [-79.3832, 43.6532];

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns a darker border colour for a route's outline layer.
 *  Known route colours use exact hardcoded values; anything else
 *  gets a computed darkening based on perceptual luma. */
function darkenColor(hex: string): string {
  // Exact matches for the built-in lines
  const known: Record<string, string> = {
    "#FFCD00": "#E3A007", // Line 1 – yellow → amber
    "#00A650": "#005C2E", // Line 2 – green  → forest green
    "#B100CD": "#5B006B", // Line 3 – purple → deep purple
  };
  const match = known[hex.toUpperCase()];
  if (match) return match;

  // Fallback: compute a perceptually-weighted lightness reduction
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const luma = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  // High-luma colours darken less; low-luma colours darken more
  // (calibrated so the three known pairs map almost exactly)
  const factor = 0.51 + 1.05 * Math.pow(luma, 3.6);

  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (delta > 0) {
    s = delta / (1 - Math.abs(2 * l - 1));
    if (max === rn)      h = (((gn - bn) / delta) % 6 + 6) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else                 h = (rn - gn) / delta + 4;
    h *= 60;
  }
  const newL = l * factor;
  const c = (1 - Math.abs(2 * newL - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = newL - c / 2;
  let r2 = 0, g2 = 0, b2 = 0;
  if      (h < 60)  { r2 = c; g2 = x; }
  else if (h < 120) { r2 = x; g2 = c; }
  else if (h < 180) {          g2 = c; b2 = x; }
  else if (h < 240) {          g2 = x; b2 = c; }
  else if (h < 300) { r2 = x;          b2 = c; }
  else              { r2 = c;          b2 = x; }
  const toHex = (v: number) =>
    Math.round(Math.max(0, Math.min(255, (v + m) * 255))).toString(16).padStart(2, "0");
  return `#${toHex(r2)}${toHex(g2)}${toHex(b2)}`;
}

// ─── Map layer stacking ────────────────────────────────────────────────────────
// Mapbox draws layers strictly in their array order (bottom→top); there are no
// "layer groups", so we manage z-order by hand with addLayer(beforeId) and
// moveLayer. These helpers centralise the two rules we re-stack against.
// 📖 Learn: moveLayer(id, beforeId) puts `id` directly BELOW `beforeId`;
//   moveLayer(id) with no beforeId lifts it to the very top.

/** AI-annotation overlay layers, listed bottom→top in the order they paint.
 *  These are things the user explicitly asked the AI to draw, so they must
 *  always sit on the very top — above route lines AND basemap labels. */
const AI_OVERLAY_LAYER_IDS = [
  "ai-highlights-fill",
  "ai-highlights-line",
  "ai-corridors-line",
  "ai-pins-layer",
  "ai-pins-label",
  "ai-edit-handles-midpoint",
  "ai-edit-handles-vertex",
] as const;

/** The lowest AI-overlay layer currently on the map, or undefined if none.
 *  Used as a moveLayer `beforeId` anchor so re-stacking the route layers can
 *  lift them high WITHOUT ever rising above the AI overlay. When no AI overlay
 *  exists, callers pass this undefined → moveLayer lifts to the very top. */
function aiOverlayFloor(map: mapboxgl.Map): string | undefined {
  return AI_OVERLAY_LAYER_IDS.find((id) => map.getLayer(id));
}

/** True for a basemap symbol layer that renders a place / admin NAME label
 *  (neighbourhood, city, region, country). In Mapbox light/dark-v11 these are
 *  the "settlement-*", "state-*", "country-*" and "continent-*" layers — the
 *  grey "FINANCIAL DISTRICT" / "Toronto" text. We keep these BELOW the route
 *  lines so the lines read clearly over them. Every OTHER label (road names,
 *  transit-station pills, POIs) stays ABOVE the lines so it stays legible. */
function isPlaceNameLabel(layer: mapboxgl.LayerSpecification): boolean {
  if (layer.type !== "symbol") return false;
  const hasText = (layer.layout as Record<string, unknown> | undefined)?.["text-field"];
  if (!hasText) return false;
  return /^(settlement|state|country|continent)/.test(layer.id);
}

/** Approximate circle as a closed ring of [lng,lat] pairs. */
function circlePolygon(center: [number, number], radiusM: number, steps = 36): [number, number][] {
  const lngPerM = 1 / (111320 * Math.cos(center[1] * Math.PI / 180));
  const latPerM = 1 / 110540;
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * 2 * Math.PI;
    return [center[0] + Math.cos(a) * radiusM * lngPerM, center[1] + Math.sin(a) * radiusM * latPerM] as [number, number];
  });
}

// Build a rounded-rectangle "pill" as a STRETCHABLE map image (9-slice).
// 📖 Learn: stretchable images + icon-text-fit — MapLibre/Mapbox stretch only
// the regions named by stretchX/stretchY to wrap whatever text the label holds,
// so the rounded ends stay crisp at any width. All coords below are in the raw
// image's own pixels (the on-screen size is divided by pixelRatio).
function makePillImage(fill: string, stroke: string) {
  const S = 40; // raw image is 40×40 px; pixelRatio 2 → 20 px tall on screen
  const R = 20; // radius = half height → fully rounded "capsule" ends
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  // Rounded-rect path via arcTo (clockwise from the top edge).
  ctx.beginPath();
  ctx.moveTo(R, 0);
  ctx.arcTo(S, 0, S, S, R);
  ctx.arcTo(S, S, 0, S, R);
  ctx.arcTo(0, S, 0, 0, R);
  ctx.arcTo(0, 0, S, 0, R);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = stroke;
  ctx.stroke();
  return {
    data: ctx.getImageData(0, 0, S, S),
    options: {
      pixelRatio: 2,
      // A 2px-wide stretch band through the centre of each axis; everything
      // outside it (the rounded ends) is held fixed.
      stretchX: [[R - 1, R + 1]] as [number, number][],
      stretchY: [[R - 1, R + 1]] as [number, number][],
      // Inset where the text actually sits (keeps text off the rounded ends).
      content: [8, 8, S - 8, S - 8] as [number, number, number, number],
    },
  };
}

function getRouteMetrics(routes: Route[]): RouteMetrics {
  return routes.reduce<RouteMetrics>(
    (acc, route) => {
      acc.total_lines += 1;
      acc.total_stations += route.stops.length;
      acc.total_portals += route.portals?.length ?? 0;
      if (route.id.startsWith("custom-")) acc.custom_lines += 1;
      if (route.type === "subway") acc.subway_lines += 1;
      if (route.type === "streetcar") acc.streetcar_lines += 1;
      if (route.type === "bus") acc.bus_lines += 1;
      return acc;
    },
    {
      total_lines: 0,
      total_stations: 0,
      total_portals: 0,
      custom_lines: 0,
      subway_lines: 0,
      streetcar_lines: 0,
      bus_lines: 0,
    },
  );
}

// ─── shareable URL helpers ───────────────────────────────────────────────────

async function compressToBase64(data: string): Promise<string> {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  writer.write(new TextEncoder().encode(data));
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0; for (const c of chunks) { total.set(c, off); off += c.length; }
  return btoa(String.fromCharCode(...total));
}

async function decompressFromBase64(b64: string): Promise<string> {
  const bin = atob(b64);
  const bytes = Uint8Array.from({ length: bin.length }, (_, i) => bin.charCodeAt(i));
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0; for (const c of chunks) { total.set(c, off); off += c.length; }
  return new TextDecoder().decode(total);
}

// ─── main map component ──────────────────────────────────────────────────────

export function TransitMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const {
    annotations: aiAnnotations,
    visible: aiAnnotationsVisible,
    setVisible: setAiAnnotationsVisible,
    focusedId: aiFocusedId,
    clearFocus: clearAiFocus,
    editing: aiEditing,
    updateAnnotationArgs: updateAiAnnotationArgs,
  } = useAIAnnotations();

  // Live refs so the drag handlers (attached once) always read the latest
  // annotations + setter without re-attaching listeners on every change.
  const aiAnnotationsRef = useRef<AIAnnotation[]>(aiAnnotations);
  useEffect(() => { aiAnnotationsRef.current = aiAnnotations; }, [aiAnnotations]);
  const updateAiAnnotationArgsRef = useRef(updateAiAnnotationArgs);
  useEffect(() => { updateAiAnnotationArgsRef.current = updateAiAnnotationArgs; }, [updateAiAnnotationArgs]);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  // Holds a stop *id*, not a name — two stops on one line can share a name, and
  // this drives both the RoutePanel highlight and its delete button.
  const [selectedStop, setSelectedStop] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedRoute, setGeneratedRoute] = useState<GeneratedRoute | null>(null);
  const [selectedGeneratedStop, setSelectedGeneratedStop] = useState<string | null>(null);
  const [disabledStops, setDisabledStops] = useState<Set<string>>(new Set());
  const [showCanadaPop, setShowCanadaPop] = useState(false);
  const [canadaPopLoading, setCanadaPopLoading] = useState(false);
  const [isBirdsEye, setIsBirdsEye] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>("normal");
  const [councilOpen, setCouncilOpen] = useState(false);
  const [councilHasRun, setCouncilHasRun] = useState(false);
  const [councilRunning, setCouncilRunning] = useState(false);
  const [councilStartNew, setCouncilStartNew] = useState(false);
  const [councilPreview, setCouncilPreview] = useState<Array<{ color: string; stops: { name: string; coords: [number, number] }[] }> | null>(null);

  // ── line-editor state (declared before stationPopulations useMemo)
  const [addStationToLine, setAddStationToLine] = useState<string | null>(null);
  const [addPortalToLine, setAddPortalToLine] = useState<string | null>(null);
  const [routes, setRoutes] = useState<Route[]>(() => [
    ...ROUTES.filter((r) => r.type === "streetcar"),
    ...ROUTES.filter((r) => r.type !== "bus" && r.type !== "streetcar"),
  ]);
  // ROUTES already carries stop ids (stamped in transit-data), so no backfill
  // is needed here — but every *other* way routes enter this state does need
  // one. See withStopIds() calls in handleLoadPlan, applyRoutes, the share-hash
  // decoder, onActivateRoute and the council adopt handler.
  // Derive selectedRoute from routes so any mutation (rename, delete stop, etc.) is reflected automatically
  const selectedRoute = routes.find((r) => r.id === selectedRouteId) ?? null;
  const [importError, setImportError] = useState<string | null>(null);
  const [pendingImportFile, setPendingImportFile] = useState<File | null>(null);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [showIEDropdown, setShowIEDropdown] = useState(false);
  const ieDropdownRef = useRef<HTMLDivElement>(null);
  const [showSettingsMenu, setShowSettingsMenu] = useState(false);
  const settingsMenuRef = useRef<HTMLDivElement>(null);
  const [advancedMode, setAdvancedMode] = useState(false);
  const [experimentalFeatures, setExperimentalFeatures] = useState(false);
  const [randomizeSpeakingOrder, setRandomizeSpeakingOrder] = useState(true);
  /** Settings accordion: Advanced section starts collapsed. */
  const [advancedSettingsExpanded, setAdvancedSettingsExpanded] = useState(false);
  const [showGoTrain, setShowGoTrain] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showPlansPanel, setShowPlansPanel] = useState(false);
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);
  const lastSavedRoutesRef = useRef<Route[] | null>(null);
  const planIsDirty = currentPlanId !== null && routes !== lastSavedRoutesRef.current;
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [imperial, setImperial] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [aiProvider, setAiProvider] = useState<"anthropic" | "gemini">("anthropic");
  const [highContrast, setHighContrast] = useState(false);
  const { user: authUser, isLoading: authLoading } = useUser();
  const [validationResult, setValidationResult] = useState<{
    result: import("~/lib/gtfs-validate").ValidationResult;
    context: "export" | "import";
  } | null>(null);

  const { showTraffic, trafficLoading, trafficGeoJSON, setShowTraffic } = useTraffic(mapRef, mapLoaded);
  const { showHeatmap, popLoading, setShowHeatmap, popRawData } = useHeatmap(mapRef, mapLoaded);
  const { customOverlay, customOverlayName, handleOverlayImport, clearOverlay } = useOverlay(mapRef, mapLoaded);
  const { vehiclesUpdatedAt, showLiveVehicles, setShowLiveVehicles } = useLiveVehicles(mapRef, mapLoaded);
  const { showTransitDesert, setShowTransitDesert, isComputing: desertComputing } = useTransitDesert(mapRef, mapLoaded, popRawData, routes);
  const { handleIsochroneOriginPicking, isoMode, setIsoMode, pickingIsochroneOrigin, setIsochroneMinutes, setIsochroneOrigin, isochroneOrigin, isochroneMinutes, setPickingIsochroneOrigin} = useIsochrone(mapRef, mapLoaded, TOKEN);

  // Walking-catchment radius: 800m for subway/LRT (10-min walk), 500m for streetcar/bus (6-min walk)
  const stationPopulations = useMemo(() => {
    if (popRawData.length === 0) return new Map<string, number>();
    const allStops: { name: string; coords: [number, number]; maxKm: number }[] = [];
    const seen = new Set<string>();
    const cutoff = (type: Route["type"]) => (type === "streetcar" || type === "bus" ? 0.5 : 0.8);
    const addStop = (stop: { name: string; coords: [number, number] }, type: Route["type"]) => {
      const key = `${stop.name}@${stop.coords[0]},${stop.coords[1]}`;
      if (!seen.has(key)) { seen.add(key); allStops.push({ ...stop, maxKm: cutoff(type) }); }
    };
    for (const route of routes) for (const stop of route.stops) addStop(stop, route.type);
    return computeStationPopulations(popRawData, allStops);
  }, [popRawData, routes]);

  const [hasBoundary, setHasBoundary] = useState(false);
  const [selectedNeighbourhoods, setSelectedNeighbourhoods] = useState<Set<string>>(new Set());
  const [selectedStations, setSelectedStations] = useState<Set<string>>(new Set()); // "name::routeId"
  const [focusedNeighbourhood, setFocusedNeighbourhood] = useState<{ id: string; name: string; lat: number; lng: number; geometry: GeoJSON.Geometry | null } | null>(null);
  // stopId is the stop this popup acts on. `name` is kept for display only —
  // deleting/renaming reads stopId, so two same-named stops stay distinct.
  const [stationPopup, setStationPopup] = useState<{ stopId: string; name: string; routeId: string; x: number; y: number; coords: [number, number] } | null>(null);
  // Pairs the user has explicitly dismissed as transfers: "routeA:routeB:stopName"
  // (routeIds sorted — build the key with transferExclusionKey()).
  const [transferExclusions, setTransferExclusions] = useState<Set<string>>(new Set());
  // Mirror in a ref so undo snapshots taken inside event handlers read the
  // current value rather than a stale render closure.
  const transferExclusionsRef = useRef<Set<string>>(new Set());
  useEffect(() => { transferExclusionsRef.current = transferExclusions; }, [transferExclusions]);
  const [showNewLineModal, setShowNewLineModal] = useState(false);
  const [showCoverageZones, setShowCoverageZones] = useState(false);
  const [showServiceHeatmap, setShowServiceHeatmap] = useState(false);
  // 📖 Learn: a Set in state — we mutate by always building a NEW Set (never
  // .add/.delete on the existing one), otherwise React's reference check sees
  // the same object and skips re-render. Default pins match what used to live
  // as standalone toolbar buttons (Population Density, Traffic) so existing
  // users see no visual change until they unpin.
  const [pinnedLayers, setPinnedLayers] = useState<Set<string>>(
    () => new Set(["heatmap", "traffic"])
  );
  const [simState, setSimState] = useState<{ hour: number; activeIds: string[] } | null>(null);
  const [linesHeight, setLinesHeight] = useState(() =>
    typeof window !== "undefined" ? Math.floor((window.innerHeight - 60) * 0.55) : 380
  );
  const linesHeightRef = useRef(linesHeight);
  const [showCatchment, setShowCatchment] = useState(false);
  const [catchmentRadius, setCatchmentRadius] = useState(800);
  const [showDisruption, setShowDisruption] = useState(false);
  const [disruptionRadius, setDisruptionRadius] = useState(200);
  const [disruptionRouteId, setDisruptionRouteId] = useState("");
  const [measureMode, setMeasureMode] = useState(false);
  const [measurePoints, setMeasurePoints] = useState<[[number, number], [number, number]] | null>(null);
  const [measureDistanceKm, setMeasureDistanceKm] = useState<number | null>(null);
  const measureModeRef = useRef(false);
  const measurePtsRef = useRef<[number, number][]>([]);
  const [showGameMode, setShowGameMode] = useState(false);
  const [showStationLabels, setShowStationLabels] = useState(false);
  const [showSimPanel, setShowSimPanel] = useState(false);
  const [showAIChat, setShowAIChat] = useState(false);
  // Whether the free-form "Ask AI" entry point is surfaced at all. Hidden by
  // default; opt-in via the Settings menu. Distinct from `showAIChat`, which is
  // whether the chat panel is currently *open*.
  const [showAskAIButton, setShowAskAIButton] = useState(false);
  // Right-click context menu — fires when the user right-clicks on the map.
  // `x` and `y` are CSS pixel coordinates relative to the viewport so we can
  // position the menu directly at the cursor.
  const [mapCtxMenu, setMapCtxMenu] = useState<{ lat: number; lng: number; x: number; y: number; neighbourhood: string | null } | null>(null);
  // Seed text passed to the AI chat (e.g. "About Yonge–Eglinton: " when the
  // user picks "Ask AI about here"). The chat consumes this once on open then
  // clears it; nulling here resets the pipe.
  const [aiSeed, setAiSeed] = useState<string | null>(null);
  const [simResults, setSimResults] = useState<SimulationResult | null>(null);
  const [animAgents, setAnimAgents] = useState<import("./map/SimulationPanel").PerAgentResult[] | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const animStartRef = useRef<number | null>(null);
  const [snapProgress, setSnapProgress] = useState<{ routeId: string; pct: number } | null>(null);
  const snapDebounceRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const goShapesRef = useRef<Map<string, [number, number][]>>(new Map());
  const applyGoShapes = (rs: Route[]) =>
    rs.map((r) => r._variantId && goShapesRef.current.has(r._variantId) ? { ...r, shape: goShapesRef.current.get(r._variantId) } : r);
  const shimmerAnimRef = useRef(new Map<string, number>());
  const windingAnimRef = useRef(new Map<string, number>()); // tracks in-progress winding animation RAFs
  const drawAnimRef = useRef(new Map<string, number>()); // tracks line draw-in animation RAFs
  const startShimmerRef = useRef<(routeId: string) => void>(() => {});
  const stopCounterRef = useRef(1);
  const customLineCounterRef = useRef(1);
  const historyRef = useRef<HistoryState[]>([]);
  const redoStackRef = useRef<HistoryState[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [shareLinkCopied, setShareLinkCopied] = useState(false);
  const pendingViewRef = useRef<{ center: [number, number]; zoom: number } | null>(null);

  // ── Lines panel: collapsible sections + per-route visibility + timetable expand
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({ bus: true });
  const [hiddenRoutes, setHiddenRoutes] = useState<Set<string>>(
    new Set(BUS_ROUTES.map((r) => r.id)),
  );


  // Tracks the previous hiddenRoutes snapshot so the visibility effect only
  // calls setLayoutProperty for routes whose state actually changed.
  const prevHiddenRef = useRef<Set<string>>(new Set(BUS_ROUTES.map((r) => r.id)));

  // Refs for use inside map event callbacks (avoid stale closure)
  const drawModeRef = useRef<DrawMode>("normal");
  const selectedNeighbourhoodsRef = useRef<Set<string>>(new Set());
  const selectedStationsRef = useRef<Set<string>>(new Set());
  const addStationToLineRef = useRef<string | null>(null);
  const addPortalToLineRef = useRef<string | null>(null);
  const triggerAutoSnapRef = useRef<(routeId: string) => void>(() => {});
  const routesRef = useRef<Route[]>([]);
  // Precomputed stop-dot layer IDs for click-hit-testing — avoids scanning
  // getStyle().layers (1000+ entries) on every map click. Updated when custom
  // lines are added/removed.
  const stopDotLayerIdsRef = useRef<string[]>(["bus-stops-dot"]);
  // Blocks neighbourhood clicks for one tick after a polygon is completed,
  // preventing the closing double-click from immediately selecting a neighbourhood.
  const justCompletedBoundaryRef = useRef(false);
  // Cache for the full neighbourhood GeoJSON (needed for geometry lookups on click)
  const neighbourhoodsGeoJSONRef = useRef<GeoJSON.FeatureCollection | null>(null);
  const didDragStopRef = useRef(false); // suppresses click after a drag
  const stationPopupRef = useRef<typeof stationPopup>(null);
  const shimmerRafRef = useRef<number | null>(null);
  const toolAnimRafsRef = useRef<Map<string, number>>(new Map());
  const toolAnimTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const toolAnimFeaturesRef = useRef<GeoJSON.Feature[]>([]);
  // Direct callback ref — called synchronously on each SSE event, bypassing React batching
  const onToolCallRef = useRef<(evt: ToolCallEvent) => void>(() => { /* set below */ });
  const councilHasRunRef = useRef(false);
  const prevRouteMetricsRef = useRef<RouteMetrics>(getRouteMetrics(routes));
  const routesInitialTrackRef = useRef(true);
  const heatmapInitialTrackRef = useRef(true);
  const trafficInitialTrackRef = useRef(true);
  const canadaPopInitialTrackRef = useRef(true);
  const liveVehiclesInitialTrackRef = useRef(true);
  const transitDesertInitialTrackRef = useRef(true);
  const darkModeInitialTrackRef = useRef(true);
  const highContrastInitialTrackRef = useRef(true);
  const imperialInitialTrackRef = useRef(true);
  const advancedModeInitialTrackRef = useRef(true);
  const experimentalFeaturesInitialTrackRef = useRef(true);
  const goTrainInitialTrackRef = useRef(true);


  useEffect(() => {
    councilHasRunRef.current = councilHasRun;
  }, [councilHasRun]);

function getAnalyticsContext(routeList: Route[] = routesRef.current) {
    return {
      ...getRouteMetrics(routeList),
      selected_neighbourhoods: selectedNeighbourhoodsRef.current.size,
      selected_stations: selectedStationsRef.current.size,
      generated_route_visible: Boolean(generatedRoute),
    };
  }

  useEffect(() => {
    if (!authUser?.sub) return;
    identifyAnalyticsUser(authUser.sub, {
      email: authUser.email,
      name: authUser.name,
      nickname: authUser.nickname,
    });
  }, [authUser]);

  useEffect(() => {
    const metrics = getRouteMetrics(routes);
    registerAnalyticsSuperProps(metrics);

    if (routesInitialTrackRef.current) {
      routesInitialTrackRef.current = false;
      prevRouteMetricsRef.current = metrics;
      return;
    }

    const previous = prevRouteMetricsRef.current;
    const lineDelta = metrics.total_lines - previous.total_lines;
    const stationDelta = metrics.total_stations - previous.total_stations;
    const portalDelta = metrics.total_portals - previous.total_portals;

    if (lineDelta !== 0 || stationDelta !== 0 || portalDelta !== 0) {
      trackEvent("Network Updated", {
        ...metrics,
        line_delta: lineDelta,
        station_delta: stationDelta,
        portal_delta: portalDelta,
      });
    }

    prevRouteMetricsRef.current = metrics;
  }, [routes]);

  useEffect(() => {
    if (heatmapInitialTrackRef.current) {
      heatmapInitialTrackRef.current = false;
      return;
    }
    trackEvent("Population Heatmap Toggled", {
      enabled: showHeatmap,
      ...getAnalyticsContext(),
    });
  }, [showHeatmap]);

  useEffect(() => {
    if (trafficInitialTrackRef.current) {
      trafficInitialTrackRef.current = false;
      return;
    }
    trackEvent("Traffic Overlay Toggled", {
      enabled: showTraffic,
      ...getAnalyticsContext(),
    });
  }, [showTraffic]);

  useEffect(() => {
    if (canadaPopInitialTrackRef.current) {
      canadaPopInitialTrackRef.current = false;
      return;
    }
    trackEvent("Canada Population Overlay Toggled", {
      enabled: showCanadaPop,
      ...getAnalyticsContext(),
    });
  }, [showCanadaPop]);

  useEffect(() => {
    if (liveVehiclesInitialTrackRef.current) {
      liveVehiclesInitialTrackRef.current = false;
      return;
    }
    trackEvent("Live Vehicles Toggled", {
      enabled: showLiveVehicles,
      ...getAnalyticsContext(),
    });
  }, [showLiveVehicles]);

  useEffect(() => {
    if (transitDesertInitialTrackRef.current) {
      transitDesertInitialTrackRef.current = false;
      return;
    }
    trackEvent("Transit Desert Toggled", {
      enabled: showTransitDesert,
      ...getAnalyticsContext(),
    });
  }, [showTransitDesert]);

  useEffect(() => {
    if (darkModeInitialTrackRef.current) {
      darkModeInitialTrackRef.current = false;
      return;
    }
    trackEvent("Dark Mode Toggled", {
      enabled: darkMode,
      ...getAnalyticsContext(),
    });
  }, [darkMode]);

  useEffect(() => {
    if (highContrastInitialTrackRef.current) {
      highContrastInitialTrackRef.current = false;
      return;
    }
    trackEvent("High Contrast Toggled", {
      enabled: highContrast,
      ...getAnalyticsContext(),
    });
  }, [highContrast]);

  useEffect(() => {
    if (imperialInitialTrackRef.current) {
      imperialInitialTrackRef.current = false;
      return;
    }
    trackEvent("Imperial Units Toggled", {
      enabled: imperial,
      ...getAnalyticsContext(),
    });
  }, [imperial]);

  useEffect(() => {
    if (advancedModeInitialTrackRef.current) {
      advancedModeInitialTrackRef.current = false;
      return;
    }
    trackEvent("Tools Panel Toggled", {
      enabled: advancedMode,
      ...getAnalyticsContext(),
    });
  }, [advancedMode]);

  useEffect(() => {
    if (experimentalFeaturesInitialTrackRef.current) {
      experimentalFeaturesInitialTrackRef.current = false;
      return;
    }
    trackEvent("Experimental Features Toggled", {
      enabled: experimentalFeatures,
      ...getAnalyticsContext(),
    });
  }, [experimentalFeatures]);

  useEffect(() => {
    if (goTrainInitialTrackRef.current) {
      goTrainInitialTrackRef.current = false;
      return;
    }
    trackEvent("GO Transit Toggled", {
      enabled: showGoTrain,
      ...getAnalyticsContext(),
    });
  }, [showGoTrain]);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    selectedNeighbourhoodsRef.current = selectedNeighbourhoods;
  }, [selectedNeighbourhoods]);

  useEffect(() => {
    selectedStationsRef.current = selectedStations;
  }, [selectedStations]);

  // Update map highlight layers whenever selectedStations changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    routesRef.current.forEach((route) => {
      const layerId = `stops-selected-${route.id}`;
      if (!map.getLayer(layerId)) return;
      const names = [...selectedStations]
        .filter((k) => k.endsWith(`::${route.id}`))
        .map((k) => k.split("::")[0]!);
      map.setFilter(
        layerId,
        names.length > 0
          ? ["in", ["get", "name"], ["literal", names]]
          : ["==", ["get", "name"], "__none__"],
      );
    });
  }, [selectedStations, mapLoaded]);

  useEffect(() => {
    addStationToLineRef.current = addStationToLine;
  }, [addStationToLine]);

  useEffect(() => {
    addPortalToLineRef.current = addPortalToLine;
  }, [addPortalToLine]);

  useEffect(() => {
    routesRef.current = routes;
    stopDotLayerIdsRef.current = [
      "bus-stops-dot",
      ...routes.map((r) => `stops-dot-${r.id}`),
    ];
    // Update map sources for any routes whose stops changed
    const map = mapRef.current;
    if (map) {
      for (const route of routes) {
        if (map.getSource(`route-${route.id}`)) {
          const allStops = route.stops;
          // Don't overwrite the route line source while a winding animation owns it
          if (!windingAnimRef.current.has(route.id)) {
            (map.getSource(`route-${route.id}`) as mapboxgl.GeoJSONSource).setData(
              allStops.length >= 2 ? routeToGeoJSON(route) : { type: "FeatureCollection", features: [] }
            );
          }
          (map.getSource(`stops-${route.id}`) as mapboxgl.GeoJSONSource).setData(stopsToGeoJSON({ ...route, stops: allStops }));
          if (map.getSource(`portals-${route.id}`)) {
            (map.getSource(`portals-${route.id}`) as mapboxgl.GeoJSONSource).setData(portalsToGeoJSON(route));
          }
          if (map.getSource(`underground-${route.id}`)) {
            (map.getSource(`underground-${route.id}`) as mapboxgl.GeoJSONSource).setData(undergroundToGeoJSON(route));
          }
        }
      }
    }
  }, [routes]);

  useEffect(() => {
    stationPopupRef.current = stationPopup;
  }, [stationPopup]);

  // ── Unsaved-changes guard ─────────────────────────────────────────────────
  const DEFAULT_ROUTE_IDS = new Set([...ROUTES, ...GO_TRAIN_ROUTES].map((r) => r.id));
  const hasUnsaved = routes.some((r) => !DEFAULT_ROUTE_IDS.has(r.id));

  // Native browser dialog on tab close / refresh
  useEffect(() => {
    if (!hasUnsaved) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsaved]);

  // Dark mode — sync to <html> class and persist
  const darkModeInitRef = useRef(true); // skip localStorage write on first render (before restore effect reads system pref)
  const darkModeMapRef = useRef(true); // skip first map style switch (map not ready yet)
  useEffect(() => {
    document.documentElement.classList.toggle("dark", darkMode);
    if (darkModeInitRef.current) { darkModeInitRef.current = false; return; }
    localStorage.setItem("darkMode", darkMode ? "1" : "0");
  }, [darkMode]);

  // High contrast — sync to <html> class and persist
  useEffect(() => {
    document.documentElement.classList.toggle("hc", highContrast);
    localStorage.setItem("highContrast", highContrast ? "1" : "0");
  }, [highContrast]);
  useEffect(() => {
    if (darkModeMapRef.current) { darkModeMapRef.current = false; return; }
    const map = mapRef.current;
    if (!map) return;
    const style = darkMode ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11";
    setMapLoaded(false);
    map.setStyle(style);
    map.once("style.load", () => setMapLoaded(true));
  }, [darkMode]);

  // Decode shareable URL hash on mount
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#plan=")) return;
    void decompressFromBase64(hash.slice(6)).then((json) => {
      try {
        const state = JSON.parse(json) as { routes?: Route[]; hiddenRoutes?: string[]; transferExclusions?: string[]; center?: [number, number]; zoom?: number };
        if (Array.isArray(state.routes)) {
          const shared = withStopIds(state.routes);
          setRoutes(shared);
          routesRef.current = shared;
        }
        if (Array.isArray(state.hiddenRoutes)) setHiddenRoutes(new Set(state.hiddenRoutes));
        // Older share links predate this field — absent means "no dismissals".
        if (Array.isArray(state.transferExclusions)) {
          const excl = new Set(state.transferExclusions);
          setTransferExclusions(excl);
          transferExclusionsRef.current = excl;
        }
        if (state.center && state.zoom) pendingViewRef.current = { center: state.center, zoom: state.zoom };
      } catch { /* malformed hash — ignore */ }
    });
  }, []);

  // Apply pending viewport from URL hash once map is ready
  useEffect(() => {
    if (!mapLoaded || !pendingViewRef.current) return;
    const { center, zoom } = pendingViewRef.current;
    pendingViewRef.current = null;
    mapRef.current?.flyTo({ center, zoom, duration: 0 });
  }, [mapLoaded]);

  // Restore toggles from localStorage after mount (avoids SSR/client hydration mismatch)
  useEffect(() => {
    const get = (k: string) => localStorage.getItem(k) === "1";
    setShowHeatmap(get("t_showHeatmap"));
    setShowTraffic(get("t_showTraffic"));
    setAdvancedMode(get("t_advancedMode"));
    setExperimentalFeatures(get("t_experimentalFeatures"));
    const speakingOrder = localStorage.getItem("t_randomizeSpeakingOrder");
    setRandomizeSpeakingOrder(speakingOrder === null ? true : speakingOrder === "1");
    setImperial(get("t_imperial"));
    setShowCoverageZones(get("t_showCoverageZones"));
    setShowServiceHeatmap(get("t_showServiceHeatmap"));
    // Pinned layers — stored as JSON array. If missing, keep the default
    // (heatmap + traffic) we set in initial useState, so first-time users
    // see the same two quick-toggles they had before this refactor.
    try {
      const raw = localStorage.getItem("t_pinnedLayers");
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) setPinnedLayers(new Set(arr.filter((x): x is string => typeof x === "string")));
      }
    } catch { /* ignore malformed JSON */ }
    const stored = localStorage.getItem("darkMode");
    setDarkMode(stored !== null ? stored === "1" : window.matchMedia("(prefers-color-scheme: dark)").matches);
    setHighContrast(get("highContrast"));
    setShowStationLabels(get("t_showStationLabels"));
    setShowAskAIButton(get("t_showAskAI")); // absent → false → button stays hidden
    const storedProvider = localStorage.getItem("aiProvider");
    if (storedProvider === "gemini") setAiProvider("gemini");

    // Follow OS theme changes in real time when no manual preference is stored
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onSystemThemeChange = (e: MediaQueryListEvent) => {
      if (localStorage.getItem("darkMode") === null) setDarkMode(e.matches);
    };
    mq.addEventListener("change", onSystemThemeChange);
    return () => mq.removeEventListener("change", onSystemThemeChange);
  }, []);

  // Persist toggles to localStorage
  useEffect(() => { localStorage.setItem("t_showHeatmap", showHeatmap ? "1" : "0"); }, [showHeatmap]);
  useEffect(() => { localStorage.setItem("t_showTraffic", showTraffic ? "1" : "0"); }, [showTraffic]);
  useEffect(() => { localStorage.setItem("t_experimentalFeatures", experimentalFeatures ? "1" : "0"); }, [experimentalFeatures]);
  useEffect(() => { localStorage.setItem("t_advancedMode", advancedMode ? "1" : "0"); }, [advancedMode]);
  useEffect(() => { localStorage.setItem("t_randomizeSpeakingOrder", randomizeSpeakingOrder ? "1" : "0"); }, [randomizeSpeakingOrder]);
  useEffect(() => { localStorage.setItem("t_imperial", imperial ? "1" : "0"); }, [imperial]);
  useEffect(() => { localStorage.setItem("aiProvider", aiProvider); }, [aiProvider]);
  useEffect(() => { localStorage.setItem("t_showAskAI", showAskAIButton ? "1" : "0"); }, [showAskAIButton]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const existing = map._controls.find((c: unknown) => c instanceof mapboxgl.ScaleControl);
    if (existing) map.removeControl(existing as mapboxgl.ScaleControl);
    map.addControl(new mapboxgl.ScaleControl({ unit: imperial ? "imperial" : "metric" }), "bottom-left");
  }, [imperial]);
  useEffect(() => { localStorage.setItem("t_showCoverageZones", showCoverageZones ? "1" : "0"); }, [showCoverageZones]);
  useEffect(() => { localStorage.setItem("t_showServiceHeatmap", showServiceHeatmap ? "1" : "0"); }, [showServiceHeatmap]);
  useEffect(() => { localStorage.setItem("t_pinnedLayers", JSON.stringify([...pinnedLayers])); }, [pinnedLayers]);
  useEffect(() => { localStorage.setItem("t_showStationLabels", showStationLabels ? "1" : "0"); }, [showStationLabels]);

  // Toggle station label visibility on all routes + bus stops when the setting changes.
  // Label layers start hidden ("none") and are shown/hidden here rather than add/remove —
  // cheaper, and avoids needing to know exact layer insertion order.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const vis = showStationLabels ? "visible" : "none";
    for (const route of routes) {
      const layerId = `stops-label-${route.id}`;
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", vis);
    }
    if (map.getLayer("bus-stops-label")) map.setLayoutProperty("bus-stops-label", "visibility", vis);
  }, [showStationLabels, routes, mapLoaded]);

  // Simulation — dim inactive routes on map
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    for (const route of routes) {
      const isActive = !simState || simState.activeIds.includes(route.id);
      const bus = route.type === "bus", sc = route.type === "streetcar";
      if (map.getLayer(`route-line-${route.id}`))
        map.setPaintProperty(`route-line-${route.id}`, "line-opacity", isActive ? (bus ? 0.7 : sc ? 0.85 : 1) : 0.06);
      if (map.getLayer(`stops-dot-${route.id}`))
        map.setPaintProperty(`stops-dot-${route.id}`, "circle-opacity", isActive ? (bus ? 0.6 : 0.9) : 0.04);
    }
  }, [simState, routes, mapLoaded]);

  // Simulation stress overlay — two layers on a shared global scale:
  //   sim-baseline-stress : existing edges, colored by relief delta (green=relieved, red=more loaded)
  //   sim-proposed-stress : new line segments, blue demand scale (light=low, dark=high), dashed
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const BASE_SRC = "sim-baseline-stress-source";
    const BASE_LYR = "sim-baseline-stress-layer";
    const PROP_SRC = "sim-proposed-stress-source";
    const PROP_LYR = "sim-proposed-stress-layer";

    type StressSeg = {
      line_name?: string;
      from_coords: [number, number]; to_coords: [number, number];
      stress_pct: number; delta_pct: number;
      from_stop: string; to_stop: string;
      agent_trips: number; baseline_trips: number;
    };

    // Precompute smoothed shapes for every route so we can slice them per-segment.
    // TTC routes from the static data have `shape` (intermediate waypoints); custom
    // proposed routes may have a road-snapped `shape` from the draw tool.
    const allRoutes = [...ROUTES, ...routes];
    const routeShapes = new Map<string, [number, number][]>();
    for (const r of allRoutes) {
      if (r.stops.length >= 2) {
        routeShapes.set(r.name, routeToGeoJSON(r).geometry.coordinates as [number, number][]);
      }
    }

    // Build a GeoJSON feature using the route's actual smoothed shape for this segment,
    // so stress lines follow the same curves as the underlying map layers.
    const toFeature = (seg: StressSeg) => {
      const shape = routeShapes.get(seg.line_name ?? "");
      const coords: [number, number][] = shape
        ? sliceShapeBetween(seg.from_coords, seg.to_coords, shape)
        : [seg.from_coords, seg.to_coords];
      return {
        type: "Feature" as const,
        properties: {
          stress_pct: seg.stress_pct,
          delta_pct: seg.delta_pct,
          label: `${seg.from_stop}→${seg.to_stop} (${seg.agent_trips}${seg.baseline_trips ? `, was ${seg.baseline_trips}` : ""})`,
        },
        geometry: { type: "LineString" as const, coordinates: coords },
      };
    };

    if (!simResults) {
      [BASE_LYR, PROP_LYR].forEach((l) => { if (map.getLayer(l)) map.removeLayer(l); });
      [BASE_SRC, PROP_SRC].forEach((s) => { if (map.getSource(s)) map.removeSource(s); });
      return;
    }

    // Existing edges — width by scenario load (global scale), color by delta
    if (simResults.baseline_edge_stress.length > 0) {
      const geojson = { type: "FeatureCollection" as const, features: simResults.baseline_edge_stress.map(toFeature) };
      if (map.getSource(BASE_SRC)) {
        (map.getSource(BASE_SRC) as mapboxgl.GeoJSONSource).setData(geojson);
      } else {
        map.addSource(BASE_SRC, { type: "geojson", data: geojson });
        map.addLayer({
          id: BASE_LYR,
          type: "line",
          source: BASE_SRC,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": ["interpolate", ["linear"], ["get", "stress_pct"], 0, 2, 100, 8],
            "line-color": [
              "case",
              [">", ["get", "delta_pct"], 8],  "#10b981",
              ["<", ["get", "delta_pct"], -8], "#ef4444",
              "#f59e0b",
            ],
            "line-opacity": 0.65,
          },
        });
      }
    }

    // Proposed lines — blue demand scale on the same global normalization as existing lines.
    // Using blue (instead of green→red) makes it visually unambiguous that this is a
    // different metric (absolute ridership demand) vs the existing-line delta coloring.
    if (simResults.line_stress.length > 0) {
      const geojson = { type: "FeatureCollection" as const, features: simResults.line_stress.map(toFeature) };
      if (map.getSource(PROP_SRC)) {
        (map.getSource(PROP_SRC) as mapboxgl.GeoJSONSource).setData(geojson);
      } else {
        map.addSource(PROP_SRC, { type: "geojson", data: geojson });
        map.addLayer({
          id: PROP_LYR,
          type: "line",
          source: PROP_SRC,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-width": ["interpolate", ["linear"], ["get", "stress_pct"], 0, 3, 100, 10],
            // Same green/amber/red scale as existing lines, globally normalized; dashes distinguish as proposed
            "line-color": ["case",
              ["<", ["get", "stress_pct"], 33], "#10b981",
              [">", ["get", "stress_pct"], 66], "#ef4444",
              "#f59e0b",
            ],
            "line-dasharray": [2.5, 1.5],
            "line-opacity": 0.95,
          },
        });
      }
    }
  }, [simResults, mapLoaded, routes]);

  // Agent animation — clock-driven: simulated time runs from earliest departure
  // to latest arrival, compressed into 12 seconds of real time.
  const ANIM_DURATION_MS = 12000;
  const [animClockLabel, setAnimClockLabel] = useState<string | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC = "sim-agents-source";
    const LYR = "sim-agents-layer";

    const cleanup = () => {
      if (animFrameRef.current !== null) cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
      animStartRef.current = null;
      setAnimClockLabel(null);
      if (map.getLayer(LYR)) map.removeLayer(LYR);
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    if (!animAgents?.length) { cleanup(); return; }

    const DOT_COLOR: Record<string, string> = { low: "#f97316", mid: "#8b5cf6", high: "#06b6d4" };

    // Use the selected time range from the simulation result so the clock
    // accurately spans the window the user configured, not just the narrow
    // band of agent departure times.
    const simStart = simResults?.time_range?.start_min
      ?? Math.min(...animAgents.map((a) => a.departure_min));
    const simEnd   = simResults?.time_range?.end_min
      ?? Math.max(...animAgents.map((a) => a.departure_min + (a.baseline_time || 60)));
    const simSpan  = Math.max(simEnd - simStart, 1);

    function toHHMM(mins: number): string {
      const h = Math.floor(mins / 60) % 24;
      const m = Math.floor(mins % 60);
      const ampm = h >= 12 ? "pm" : "am";
      return `${h % 12 === 0 ? 12 : h % 12}:${m.toString().padStart(2, "0")}${ampm}`;
    }

    // Pre-compute cumulative distances for path interpolation.
    // Group all legs by agent_id so each physical agent is one animated dot
    // that switches paths as the clock advances through their day.
    type LegPath = {
      coords: [number, number][];
      cumDist: number[];
      totalDist: number;
      departureMin: number;
      durationMin: number;
    };
    type AgentPath = { legs: LegPath[]; color: string };

    const buildLeg = (a: (typeof animAgents)[0]): LegPath => {
      const coords = a.path_coords;
      const cumDist: number[] = [0];
      for (let i = 1; i < coords.length; i++) {
        const [lon1, lat1] = coords[i - 1]!;
        const [lon2, lat2] = coords[i]!;
        const dLat = (lat2 - lat1) * Math.PI / 180;
        const dLon = (lon2 - lon1) * Math.PI / 180;
        const aa = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
        cumDist.push(cumDist[i - 1]! + 6371000 * 2 * Math.asin(Math.sqrt(aa)));
      }
      return { coords, cumDist, totalDist: cumDist[cumDist.length - 1] ?? 0, departureMin: a.departure_min, durationMin: Math.max(a.baseline_time, 1) };
    };

    const agentMap = new Map<number, AgentPath>();
    for (const a of animAgents) {
      if (!agentMap.has(a.agent_id)) agentMap.set(a.agent_id, { legs: [], color: DOT_COLOR[a.income] ?? "#8b5cf6" });
      agentMap.get(a.agent_id)!.legs.push(buildLeg(a));
    }
    for (const agent of agentMap.values()) agent.legs.sort((a, b) => a.departureMin - b.departureMin);
    const paths = [...agentMap.values()];

    function positionAt(path: LegPath, t: number): [number, number] {
      const target = t * path.totalDist;
      let lo = 0, hi = path.cumDist.length - 2;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (path.cumDist[mid + 1]! < target) lo = mid + 1; else hi = mid;
      }
      const seg = path.cumDist[lo + 1]! - path.cumDist[lo]!;
      const frac = seg > 0 ? (target - path.cumDist[lo]!) / seg : 0;
      const [lon1, lat1] = path.coords[lo]!;
      const [lon2, lat2] = path.coords[lo + 1] ?? path.coords[lo]!;
      return [lon1 + frac * (lon2 - lon1), lat1 + frac * (lat2 - lat1)];
    }

    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      map.addLayer({
        id: LYR,
        type: "circle",
        source: SRC,
        paint: {
          "circle-radius": 3,
          "circle-color": ["get", "color"],
          "circle-opacity": 0.85,
          "circle-stroke-width": 0.5,
          "circle-stroke-color": "#fff",
        },
      });
    }

    function frame(now: number) {
      if (!animStartRef.current) animStartRef.current = now;
      const wallT = Math.min((now - animStartRef.current) / ANIM_DURATION_MS, 1);
      // Current simulated time in minutes from midnight
      const simNow = simStart + wallT * simSpan;
      setAnimClockLabel(toHHMM(simNow));

      const features: object[] = [];
      for (const agent of paths) {
        // Find the leg this agent is currently on
        const leg = agent.legs.find((l) => simNow >= l.departureMin && simNow <= l.departureMin + l.durationMin);
        if (!leg) continue;
        const t = (simNow - leg.departureMin) / leg.durationMin;
        const [lon, lat] = positionAt(leg, t);
        features.push({
          type: "Feature",
          properties: { color: agent.color },
          geometry: { type: "Point", coordinates: [lon, lat] },
        });
      }

      (map!.getSource(SRC) as mapboxgl.GeoJSONSource | undefined)
        ?.setData({ type: "FeatureCollection", features: features as GeoJSON.Feature[] });

      if (wallT < 1) {
        animFrameRef.current = requestAnimationFrame(frame);
      } else {
        animFrameRef.current = null;
      }
    }

    animStartRef.current = null;
    animFrameRef.current = requestAnimationFrame(frame);

    return cleanup;
  }, [animAgents, simResults, mapLoaded]);

  // GO train toggle — add or remove GO routes (and their map layers)
  const goTrainMountRef = useRef(true);
  useEffect(() => {
    if (goTrainMountRef.current) { goTrainMountRef.current = false; return; }
    const GO_IDS = new Set(GO_TRAIN_ROUTES.map((r) => r.id));
    if (showGoTrain) {
      setRoutes((prev) => {
        const hasGo = prev.some((r) => GO_IDS.has(r.id));
        if (hasGo) return prev;
        return [...prev, ...applyGoShapes([...GO_TRAIN_ROUTES])];
      });
    } else {
      const map = mapRef.current;
      if (map) {
        GO_TRAIN_ROUTES.forEach((r) => {
          [`route-shadow-${r.id}`, `route-outline-${r.id}`, `route-line-${r.id}`, `route-shimmer-${r.id}`, `stops-ring-${r.id}`, `stops-selected-${r.id}`, `stops-dot-${r.id}`, `stops-label-${r.id}`, `underground-line-${r.id}`, `portals-dot-${r.id}`]
            .forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
          [`route-${r.id}`, `stops-${r.id}`, `underground-${r.id}`, `portals-${r.id}`]
            .forEach((id) => { if (map.getSource(id)) map.removeSource(id); });
        });
      }
      setRoutes((prev) => prev.filter((r) => !GO_IDS.has(r.id)));
    }
  }, [showGoTrain]);

  // Close the settings menu when clicking outside it
  useEffect(() => {
    if (!showSettingsMenu) return;
    function onOutsideClick(e: MouseEvent) {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(e.target as Node)) {
        setShowSettingsMenu(false);
      }
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [showSettingsMenu]);

  // Close the I/E dropdown when clicking outside it
  useEffect(() => {
    if (!showIEDropdown) return;
    function onOutsideClick(e: MouseEvent) {
      if (ieDropdownRef.current && !ieDropdownRef.current.contains(e.target as Node)) {
        setShowIEDropdown(false);
      }
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [showIEDropdown]);

  async function handleGenerateRoute() {
    if (isGenerating) return;
    trackEvent("Generated Route Requested", {
      ...getAnalyticsContext(),
      selected_neighbourhoods: selectedNeighbourhoodsRef.current.size,
      selected_stations: selectedStationsRef.current.size,
      has_boundary: hasBoundary,
    });
    setIsGenerating(true);
    setGeneratedRoute(null);
    setDisabledStops(new Set());

    const stops: { name: string; coords: [number, number] }[] = [];

    // One stop per selected neighbourhood at its bbox centroid
    const geoJSON = neighbourhoodsGeoJSONRef.current;
    if (geoJSON) {
      for (const id of selectedNeighbourhoodsRef.current) {
        const feat = geoJSON.features.find((f) => f.properties?.AREA_SHORT_CODE === id);
        if (!feat?.geometry) continue;
        const [minX, minY, maxX, maxY] = geomBBox(feat.geometry);
        const name = (feat.properties?.AREA_NAME as string | undefined) ?? id;
        stops.push({ name, coords: [(minX + maxX) / 2, (minY + maxY) / 2] });
      }
    }

    // One stop per selected station (use existing coords)
    for (const key of selectedStationsRef.current) {
      const [stationName, routeId] = key.split("::");
      if (!stationName || !routeId) continue;
      const route = routesRef.current.find((r) => r.id === routeId);
      const found = route?.stops.find((s) => s.name === stationName);
      if (found) stops.push({ name: found.name, coords: found.coords });
    }

    // If a boundary was drawn, add its centroid as a waypoint stop
    const draw = drawRef.current;
    if (draw && hasBoundary) {
      const features = draw.getAll().features;
      const poly = features[0];
      if (poly?.geometry) {
        const [minX, minY, maxX, maxY] = geomBBox(poly.geometry as GeoJSON.Geometry);
        stops.push({ name: "Selected Area", coords: [(minX + maxX) / 2, (minY + maxY) / 2] });
      }
    }

    if (stops.length < 2) {
      trackEvent("Generated Route Aborted", {
        ...getAnalyticsContext(),
        requested_stops: stops.length,
        reason: "not_enough_points",
      });
      setIsGenerating(false);
      return;
    }

    // Order west → east by longitude so the line flows sensibly
    stops.sort((a, b) => a.coords[0] - b.coords[0]);

    // Population within 2 km of each generated stop (from loaded census data)
    const stopPopulations = stops.map((stop) => ({
      name: stop.name,
      pop: popRawData.reduce((sum, row) =>
        haversineKm(stop.coords, [row.longitude, row.latitude]) <= 2 ? sum + row.population : sum, 0),
    }));

    // Total route length in km
    const routeLengthKm = stops.slice(1).reduce(
      (sum, s, i) => sum + haversineKm(stops[i]!.coords, s.coords), 0
    );

    // Neighbourhood names for context
    const neighbourhoodNames = [...selectedNeighbourhoodsRef.current].map((id) => {
      const feat = neighbourhoodsGeoJSONRef.current?.features.find(
        (f) => f.properties?.AREA_SHORT_CODE === id
      );
      return (feat?.properties?.AREA_NAME as string | undefined) ?? id;
    });

    const stopList = stops.map((s) => s.name).join(" → ");
    const popLines = stopPopulations
      .map((s) => `  - ${s.name}: ~${(Math.round(s.pop / 100) * 100).toLocaleString()} residents`)
      .join("\n");

    const message = [
      `Analyze this proposed Toronto subway route and produce realistic planning estimates.`,
      `Route: ${stopList}`,
      `Total length: ${routeLengthKm.toFixed(1)} km | Stations: ${stops.length}`,
      neighbourhoodNames.length > 0 ? `Neighbourhoods served: ${neighbourhoodNames.join(", ")}` : null,
      `Population within 2 km of each stop:\n${popLines}`,
      `\nReturn ONLY this JSON (no markdown, no extra text):\n{"description":"<2 sentences about route purpose>","cost":"<e.g. $2.1B>","timeline":"<e.g. 8 years>","costedTimeline":"<e.g. 2034>","minutesSaved":<number>,"dollarsSaved":"<e.g. $4.2M/yr>","percentageChance":<0-100>,"prNightmareScore":<0-10>}`,
    ].filter(Boolean).join("\n");

    // Defaults in case the Anthropic call fails
    let description = `Connects ${stopList}`;
    let stats: GeneratedRoute["stats"] = {
      cost: "$1.8B", timeline: "7 years", costedTimeline: "2033",
      minutesSaved: 12, dollarsSaved: "$3.1M/yr", percentageChance: 72, prNightmareScore: 4,
    };

    try {
      const res = await fetch("/api/ai/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          systemPrompt: "You are a Toronto transit planning analyst. Respond with ONLY valid JSON, no markdown, no extra text.",
          maxTokens: 500,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { response: string };
        const raw = data.response.trim().replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
        const ai = JSON.parse(raw) as Partial<GeneratedRoute["stats"] & { description: string }>;
        if (ai.description) description = ai.description;
        stats = {
          cost:             ai.cost             ?? stats.cost,
          timeline:         ai.timeline         ?? stats.timeline,
          costedTimeline:   ai.costedTimeline   ?? stats.costedTimeline,
          minutesSaved:     ai.minutesSaved      ?? stats.minutesSaved,
          dollarsSaved:     ai.dollarsSaved      ?? stats.dollarsSaved,
          percentageChance: ai.percentageChance  ?? stats.percentageChance,
          prNightmareScore: ai.prNightmareScore  ?? stats.prNightmareScore,
        };
      }
    } catch { /* fall back to defaults */ }

    setGeneratedRoute({
      id: `generated-${Date.now()}`,
      name: "Optimized Route",
      shortName: "OPT",
      color: "#e63946",
      textColor: "#ffffff",
      type: "subway",
      description,
      frequency: "Every 5 min",
      servicePattern: { headwayMinutes: 5, startHour: 6, endHour: 23, days: ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] },
      // Generated stops are built from selections/neighbourhoods and carry no
      // id — mint one so the generated-route dots are clickable like any other.
      stops: stops.map((s) => ({ ...s, id: newStopId() })),
      stats,
    });
    trackEvent("Generated Route Completed", {
      ...getAnalyticsContext(),
      generated_stop_count: stops.length,
      generated_length_km: Number(routeLengthKm.toFixed(2)),
      minutes_saved: stats.minutesSaved,
      approval_chance: stats.percentageChance,
      pr_nightmare_score: stats.prNightmareScore,
    });
    setIsGenerating(false);
    handleClearAll();
  }

  function distToSegmentKm(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return haversineKm(p, a);
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
    return haversineKm(p, [a[0] + t * dx, a[1] + t * dy] as [number, number]);
  }

  function bestInsertIndex(coords: [number, number], stops: { name: string; coords: [number, number] }[]): number {
    if (stops.length === 0) return 0;
    if (stops.length === 1) return 1; // just append for a single existing stop
    // Default: append after last
    let bestIdx = stops.length;
    let bestDist = haversineKm(coords, stops[stops.length - 1]!.coords);
    // Prepend before first
    const dFirst = haversineKm(coords, stops[0]!.coords);
    if (dFirst < bestDist) { bestDist = dFirst; bestIdx = 0; }
    // Insert between segments
    for (let i = 0; i < stops.length - 1; i++) {
      const d = distToSegmentKm(coords, stops[i]!.coords, stops[i + 1]!.coords);
      if (d < bestDist) { bestDist = d; bestIdx = i + 1; }
    }
    return bestIdx;
  }

  async function reverseGeocodeStation(lng: number, lat: number): Promise<string | null> {
    if (!TOKEN) return null;
    try {
      const resp = await fetch(
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=address,poi&limit=1&language=en&access_token=${TOKEN}`
      );
      if (!resp.ok) return null;
      const data = await resp.json() as { features: Array<{ text: string; place_name: string }> };
      const feature = data.features[0];
      if (!feature) return null;
      const street = (feature.place_name.split(",")[0] ?? feature.text).trim().replace(/^\d+\s+/, "");
      return street || null;
    } catch { return null; }
  }

  function captureCurrentState(): HistoryState {
    return {
      routes: [...routesRef.current],
      counter: stopCounterRef.current,
      // Copy the Set — undo must restore the dismissals as they were, and a
      // shared reference would be mutated by later edits.
      transferExclusions: new Set(transferExclusionsRef.current),
    };
  }

  function applyHistoryState(state: HistoryState) {
    stopCounterRef.current = state.counter;
    routesRef.current = state.routes;
    setRoutes(state.routes);
    transferExclusionsRef.current = state.transferExclusions;
    setTransferExclusions(state.transferExclusions);
  }

  function handleUndo() {
    const prev = historyRef.current.pop();
    if (prev === undefined) return;
    redoStackRef.current.push(captureCurrentState());
    applyHistoryState(prev);
    setCanUndo(historyRef.current.length > 0);
    setCanRedo(true);
  }

  function handleRedo() {
    const next = redoStackRef.current.pop();
    if (next === undefined) return;
    historyRef.current.push(captureCurrentState());
    applyHistoryState(next);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }

  function snapshotHistory() {
    // Reuse captureCurrentState so a field can never be added to one and
    // forgotten in the other (that's how transferExclusions got left out).
    historyRef.current.push(captureCurrentState());
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }


  function exitSelectToolToExplore() {
    const draw = drawRef.current;
    if (draw) draw.changeMode("simple_select");
    setDrawMode("normal");
    drawModeRef.current = "normal";
  }

  function applyGeneratedNeighbourhoodHighlight() {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const selectedIds = selectedNeighbourhoodsRef.current;
    const allFeatures = neighbourhoodsGeoJSONRef.current?.features ?? [];

    // Convert the neighbourhood polygons from the interactive "selected" look
    // (indigo) to the "generated" look (brief/orange), so Explore mode isn't sloppy.
    for (const f of allFeatures) {
      const id = f.properties?.AREA_SHORT_CODE as string | undefined;
      if (!id) continue;
      const on = selectedIds.has(id);
      map.setFeatureState(
        { source: "neighbourhoods", id },
        { selected: false, brief: on, hovered: false },
      );
    }
  }

  function clearNeighbourhoodSelectionAfterGeneration() {
    const map = mapRef.current;
    if (map && mapLoaded) {
      // Remove both the interactive "selected" look and the "generated" brief/orange look.
      for (const id of selectedNeighbourhoodsRef.current) {
        map.setFeatureState(
          { source: "neighbourhoods", id },
          { selected: false, brief: false, hovered: false },
        );
      }
    }
    setFocusedNeighbourhood(null);
    setSelectedNeighbourhoods(new Set());
    selectedNeighbourhoodsRef.current = new Set();
  }

  function handleGenerate() {
    trackEvent("Council Started", {
      ...getAnalyticsContext(),
      selected_neighbourhoods: selectedNeighbourhoodsRef.current.size,
      selected_stations: selectedStationsRef.current.size,
    });
    exitSelectToolToExplore();
    applyGeneratedNeighbourhoodHighlight();
    setFocusedNeighbourhood(null);
    setCouncilStartNew(true);
    setCouncilHasRun(true);
    setCouncilRunning(true);
    setCouncilOpen(true);
  }

  function handleViewCouncil() {
    trackEvent("Council Viewed", getAnalyticsContext());
    exitSelectToolToExplore();
    applyGeneratedNeighbourhoodHighlight();
    setCouncilStartNew(false);
    setCouncilOpen(true);
  }

  function handleSetDrawMode(mode: DrawMode) {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (!draw) return;
    if (mode === drawMode) return; // clicking the active mode button does nothing
    setDrawMode(mode);
    drawModeRef.current = mode;
    if (mode === "boundary") {
      // Clear neighbourhood selection when entering draw mode
      if (map && mapLoaded) {
        selectedNeighbourhoodsRef.current.forEach((id) => {
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false, brief: false });
        });
      }
      setSelectedNeighbourhoods(new Set());
      selectedNeighbourhoodsRef.current = new Set();
      draw.changeMode("draw_polygon");
    } else if (mode === "select") {
      // Exit line-edit mode when entering neighbourhood-select mode
      setAddStationToLine(null);
      addStationToLineRef.current = null;
      // Clear any drawn boundary when entering neighbourhood-select mode
      draw.deleteAll();
      setHasBoundary(false);
      draw.changeMode("simple_select");
    } else {
      // "normal" — cancel any in-progress draw and return to view mode
      draw.changeMode("simple_select");
      if (map && mapLoaded) {
        selectedNeighbourhoodsRef.current.forEach((id) => {
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false, brief: false });
        });
      }
      setSelectedNeighbourhoods(new Set());
      selectedNeighbourhoodsRef.current = new Set();
      setSelectedStations(new Set());
      selectedStationsRef.current = new Set();
    }
  }

  function handleClearAll() {
    const draw = drawRef.current;
    const map = mapRef.current;
    if (draw) {
      draw.deleteAll();
      setHasBoundary(false);
      draw.changeMode("simple_select");
    }
    if (map && mapLoaded) {
      selectedNeighbourhoodsRef.current.forEach((id) => {
        map.setFeatureState({ source: "neighbourhoods", id }, { selected: false, brief: false });
      });
    }
    setSelectedNeighbourhoods(new Set());
    setSelectedStations(new Set());
    selectedStationsRef.current = new Set();
    setDrawMode("normal");
    drawModeRef.current = "normal";
  }

  async function handleSnapToRoads(route: Route) {
    const { snapToRoads } = await import("~/lib/road-snap");
    const shape = await snapToRoads(route.stops, TOKEN);
    setRoutes((prev) =>
      prev.map((r) => r.id === route.id ? { ...r, shape } : r),
    );
  }

  function startShimmer(routeId: string) {
    const existing = shimmerAnimRef.current.get(routeId);
    if (existing !== undefined) cancelAnimationFrame(existing);
    const map = mapRef.current;
    // Use a dedicated shimmer overlay layer so the base line is never dimmed
    if (!map?.getLayer(`route-shimmer-${routeId}`)) return;
    const loop = (now: number) => {
      const opacity = 0.25 * ((Math.sin((now / 600) * Math.PI * 2) + 1) / 2);
      if (map.getLayer(`route-shimmer-${routeId}`)) {
        map.setPaintProperty(`route-shimmer-${routeId}`, "line-opacity", opacity);
      }
      shimmerAnimRef.current.set(routeId, requestAnimationFrame(loop));
    };
    shimmerAnimRef.current.set(routeId, requestAnimationFrame(loop));
  }

  function stopShimmer(routeId: string) {
    const raf = shimmerAnimRef.current.get(routeId);
    if (raf !== undefined) { cancelAnimationFrame(raf); shimmerAnimRef.current.delete(routeId); }
    const map = mapRef.current;
    if (map?.getLayer(`route-shimmer-${routeId}`)) {
      map.setPaintProperty(`route-shimmer-${routeId}`, "line-opacity", 0);
    }
  }

  startShimmerRef.current = startShimmer;

  function animateLineDraw(routeId: string, delayMs: number, isBus: boolean, isSc: boolean) {
    const map = mapRef.current;
    if (!map) return;
    const animMap = map;
    const existing = drawAnimRef.current.get(routeId);
    if (existing !== undefined) cancelAnimationFrame(existing);

    const DURATION = 320;
    const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
    let startTime: number | null = null;

    function frame(ts: number) {
      if (!startTime) startTime = ts + delayMs;
      const elapsed = ts - startTime;
      if (elapsed < 0) { drawAnimRef.current.set(routeId, requestAnimationFrame(frame)); return; }

      const t = Math.min(elapsed / DURATION, 1);
      const progress = easeOut(t);
      const trim: [number, number] = [progress, 1];

      if (animMap.getLayer(`route-line-${routeId}`))
        animMap.setPaintProperty(`route-line-${routeId}`, "line-trim-offset", trim);
      if (!isBus && !isSc && animMap.getLayer(`route-outline-${routeId}`))
        animMap.setPaintProperty(`route-outline-${routeId}`, "line-trim-offset", trim);

      if (t < 1) {
        drawAnimRef.current.set(routeId, requestAnimationFrame(frame));
      } else {
        drawAnimRef.current.delete(routeId);
        if (animMap.getLayer(`route-line-${routeId}`))
          animMap.setPaintProperty(`route-line-${routeId}`, "line-trim-offset", [0, 0]);
        if (!isBus && !isSc && animMap.getLayer(`route-outline-${routeId}`))
          animMap.setPaintProperty(`route-outline-${routeId}`, "line-trim-offset", [0, 0]);
      }
    }

    drawAnimRef.current.set(routeId, requestAnimationFrame(frame));
  }

  function triggerAutoSnap(routeId: string) {
    const existing = snapDebounceRef.current.get(routeId);
    if (existing !== undefined) clearTimeout(existing);
    const timer = setTimeout(() => {
      snapDebounceRef.current.delete(routeId);
      const route = routesRef.current.find((r) => r.id === routeId);
      if (!route || (route.type !== "bus" && route.type !== "streetcar") || route.stops.length < 2) {
        stopShimmer(routeId);
        return;
      }
      // Cancel any in-progress winding animation for this route
      const existingWind = windingAnimRef.current.get(routeId);
      if (existingWind !== undefined) {
        cancelAnimationFrame(existingWind);
        windingAnimRef.current.delete(routeId);
      }
      // Snapshot the stop positions at snap-start time; discard result if stops changed
      const stopsKey = route.stops.map((s) => s.coords.join(",")).join("|");
      setSnapProgress({ routeId, pct: 5 });
      const progressTimer = setTimeout(
        () => setSnapProgress((p) => p?.routeId === routeId ? { routeId, pct: 75 } : p),
        150,
      );
      void (async () => {
        try {
          const { snapToRoads } = await import("~/lib/road-snap");
          const snapProfile = (route.type === "bus" || route.type === "streetcar") ? "walking" : "driving";
          const shape = await snapToRoads(route.stops, TOKEN, (pct) => {
            if (pct === 100) return; // handled below
            setSnapProgress((p) => p?.routeId === routeId ? { routeId, pct: Math.max(pct, 5) } : p);
          }, snapProfile);
          clearTimeout(progressTimer);
          // Check against routesRef (current stops) before applying — discard stale snaps
          const currentKey = routesRef.current.find((r) => r.id === routeId)?.stops.map((s) => s.coords.join(",")).join("|");
          const isStale = currentKey !== stopsKey;
          if (!isStale) {
            setSnapProgress({ routeId, pct: 100 });
            // isFirstSnap = route had no shape before → winding animation
            // isFirstSnap = false → re-snap, old shape was visible → instant update
            const isFirstSnap = !route.shape;
            stopShimmer(routeId);
            const map = mapRef.current;
            const lineSrc = map?.getSource(`route-${routeId}`) as mapboxgl.GeoJSONSource | undefined;
            if (isFirstSnap && lineSrc && shape.length >= 2) {
              const finalGeoJSON = routeToGeoJSON({ ...route, shape });
              const allCoords = finalGeoJSON.geometry.coordinates as [number, number][];
              const duration = Math.min(700, Math.max(300, allCoords.length * 2));
              const startTime = performance.now();
              const animateWind = (now: number) => {
                const progress = Math.min((now - startTime) / duration, 1);
                const eased = 1 - Math.pow(1 - progress, 2);
                const showCount = Math.max(2, Math.round(eased * allCoords.length));
                lineSrc.setData({
                  type: "Feature",
                  properties: { id: routeId },
                  geometry: { type: "LineString", coordinates: allCoords.slice(0, showCount) },
                });
                if (progress < 1) {
                  const raf = requestAnimationFrame(animateWind);
                  windingAnimRef.current.set(routeId, raf);
                } else {
                  windingAnimRef.current.delete(routeId);
                  setRoutes((prev) => prev.map((r) => r.id === routeId ? { ...r, shape } : r));
                  setTimeout(() => setSnapProgress((p) => p?.routeId === routeId ? null : p), 600);
                }
              };
              const raf = requestAnimationFrame(animateWind);
              windingAnimRef.current.set(routeId, raf);
            } else {
              // Re-snap or fallback: update route state immediately
              setRoutes((prev) => prev.map((r) => r.id === routeId ? { ...r, shape } : r));
              setTimeout(() => setSnapProgress((p) => p?.routeId === routeId ? null : p), 600);
            }
          }
          // stale: stopShimmer not called here — the pending new snap will handle it
        } catch (err) {
          clearTimeout(progressTimer);
          windingAnimRef.current.delete(routeId);
          stopShimmer(routeId);
          setSnapProgress((p) => p?.routeId === routeId ? null : p);
          console.error(`[snap] failed for route ${routeId}:`, err);
          // Snap failed — restore the fallback line directly so it doesn't stay blank
          const map = mapRef.current;
          const src = map?.getSource(`route-${routeId}`) as mapboxgl.GeoJSONSource | undefined;
          if (src) {
            const failedRoute = routesRef.current.find((r) => r.id === routeId);
            src.setData(failedRoute && failedRoute.stops.length >= 2
              ? routeToGeoJSON(failedRoute)
              : { type: "FeatureCollection", features: [] });
          } else {
            console.warn(`[snap] source route-${routeId} not found, cannot restore fallback line`);
          }
        }
      })();
    }, 500);
    snapDebounceRef.current.set(routeId, timer);
  }
  triggerAutoSnapRef.current = triggerAutoSnap;

  function handleLoadPlan(
    newRoutes: Route[],
    newHiddenRoutes: Set<string>,
    planId: string,
    newTransferExclusions = new Set<string>(),
  ) {
    snapshotHistory();
    // Plans saved before stop ids existed have none — backfill on the way in so
    // delete/drag/rename can address stops properly in an old plan too.
    const withIds = withStopIds(newRoutes);
    setRoutes(withIds);
    routesRef.current = withIds;
    setHiddenRoutes(newHiddenRoutes);
    setTransferExclusions(newTransferExclusions);
    transferExclusionsRef.current = newTransferExclusions;
    setCurrentPlanId(planId);
    // Must be the same array instance we just put in state — planIsDirty is a
    // reference comparison, so handing it `newRoutes` would mark a freshly
    // loaded plan dirty the moment backfill produced a new array.
    lastSavedRoutesRef.current = withIds;
    setShowPlansPanel(false);
  }

  function handleNewPlan() {
    snapshotHistory();
    setRoutes([]);
    routesRef.current = [];
    setHiddenRoutes(new Set());
    setCurrentPlanId(null);
    lastSavedRoutesRef.current = [];
    setShowPlansPanel(false);
  }

  function copyShareLink() {
    const center = mapRef.current?.getCenter().toArray() as [number, number] | undefined;
    const zoom = mapRef.current?.getZoom();
    const state = {
      routes: routesRef.current,
      hiddenRoutes: [...hiddenRoutes],
      transferExclusions: [...transferExclusions],
      center,
      zoom,
    };
    void compressToBase64(JSON.stringify(state)).then((compressed) => {
      const url = `${window.location.origin}${window.location.pathname}#plan=${compressed}`;
      void navigator.clipboard.writeText(url).then(() => {
        setShareLinkCopied(true);
        setTimeout(() => setShareLinkCopied(false), 2500);
      });
    });
  }

  function exportSchematicSvg() {
    const visible = routes.filter((r) => !hiddenRoutes.has(r.id) && r.type !== "bus" && r.stops.length >= 2);
    if (visible.length === 0) return;

    const W = 1200, H = 800, PAD = 60;
    // Project lat/lng to canvas coords
    const lngs = visible.flatMap((r) => r.stops.map((s) => s.coords[0]));
    const lats = visible.flatMap((r) => r.stops.map((s) => s.coords[1]));
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const proj = (lng: number, lat: number): [number, number] => {
      const x = PAD + ((lng - minLng) / (maxLng - minLng || 1)) * (W - PAD * 2);
      const y = H - PAD - ((lat - minLat) / (maxLat - minLat || 1)) * (H - PAD * 2);
      return [x, y];
    };

    const lines: string[] = [];

    // Background
    lines.push(`<rect width="${W}" height="${H}" fill="#1a1a2e"/>`);

    // Grid lines (faint)
    for (let i = 0; i <= 4; i++) {
      const x = PAD + (i / 4) * (W - PAD * 2);
      const y = PAD + (i / 4) * (H - PAD * 2);
      lines.push(`<line x1="${x}" y1="${PAD}" x2="${x}" y2="${H - PAD}" stroke="#ffffff08" stroke-width="1"/>`);
      lines.push(`<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="#ffffff08" stroke-width="1"/>`);
    }

    // Route lines
    for (const route of visible) {
      const pts = route.stops.map((s) => proj(s.coords[0], s.coords[1]));
      const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
      const strokeW = route.type === "streetcar" ? 3 : route.type === "go_train" ? 4 : 6;
      lines.push(`<path d="${d}" fill="none" stroke="${route.color}" stroke-width="${strokeW}" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>`);
    }

    // Stop dots + labels
    for (const route of visible) {
      for (const stop of route.stops) {
        const [x, y] = proj(stop.coords[0], stop.coords[1]);
        const r = route.type === "streetcar" ? 3 : 5;
        lines.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${route.color}" stroke="#1a1a2e" stroke-width="1.5"/>`);
        lines.push(`<text x="${(x + 7).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="9" fill="#ffffffcc">${stop.name.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</text>`);
      }
    }

    // Legend
    const legendX = W - PAD - 160, legendY = PAD;
    lines.push(`<rect x="${legendX - 8}" y="${legendY - 8}" width="175" height="${visible.length * 18 + 24}" rx="6" fill="#00000066"/>`);
    lines.push(`<text x="${legendX}" y="${legendY + 8}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" font-weight="bold" fill="#ffffff99" letter-spacing="1">LINES</text>`);
    for (let i = 0; i < visible.length; i++) {
      const r = visible[i]!;
      const ly = legendY + 22 + i * 18;
      lines.push(`<rect x="${legendX}" y="${ly - 6}" width="16" height="6" rx="3" fill="${r.color}"/>`);
      lines.push(`<text x="${legendX + 22}" y="${ly}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="10" fill="#ffffffcc">${r.name.replace(/&/g, "&amp;")}</text>`);
    }

    // Title
    lines.push(`<text x="${PAD}" y="${H - 16}" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" fill="#ffffff55">Transit Planner · ${new Date().toLocaleDateString("en-CA")}</text>`);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${lines.join("")}</svg>`;
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "transit-schematic.svg";
    a.click();
  }

  function buildExportCanvas(): HTMLCanvasElement | null {
    const mapCanvas = mapRef.current?.getCanvas();
    if (!mapCanvas) return null;
    const W = mapCanvas.width, H = mapCanvas.height;
    const out = document.createElement("canvas");
    out.width = W; out.height = H;
    const ctx = out.getContext("2d");
    if (!ctx) return null;

    // Draw base map
    ctx.drawImage(mapCanvas, 0, 0);

    const pad = 16, r = 10;
    const pill = (x: number, y: number, w: number, h: number) => {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
    };

    // ── Title pill (top-left)
    const date = new Date().toLocaleDateString("en-CA", { year: "numeric", month: "long", day: "numeric" });
    ctx.font = "bold 15px ui-sans-serif, system-ui, sans-serif";
    const titleW = ctx.measureText("Transit Planner").width;
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    const dateW = ctx.measureText(date).width;
    const boxW = Math.max(titleW, dateW) + 32;
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    pill(pad, pad, boxW, 56);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 15px ui-sans-serif, system-ui, sans-serif";
    ctx.fillText("Transit Planner", pad + 16, pad + 22);
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText(date, pad + 16, pad + 42);

    // ── Legend (bottom-left) — subway + LRT + GO only
    const legendRoutes = routes.filter(r => r.type !== "bus" && !hiddenRoutes.has(r.id));
    if (legendRoutes.length > 0) {
      const lineH = 22, dotR = 5, innerPad = 14;
      const lH = innerPad * 2 + legendRoutes.length * lineH;
      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      const maxLabel = Math.max(...legendRoutes.map(r => ctx.measureText(r.name).width));
      const lW = innerPad + dotR * 2 + 8 + maxLabel + innerPad;
      const lx = pad, ly = H - pad - lH;
      ctx.fillStyle = "rgba(0,0,0,0.62)";
      pill(lx, ly, lW, lH);
      legendRoutes.forEach((route, i) => {
        const cy = ly + innerPad + i * lineH + lineH / 2;
        ctx.beginPath();
        ctx.arc(lx + innerPad + dotR, cy, dotR, 0, Math.PI * 2);
        ctx.fillStyle = route.color;
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(route.name, lx + innerPad + dotR * 2 + 8, cy + 4);
      });
    }

    return out;
  }

  function exportMapPng() {
    const out = buildExportCanvas();
    if (!out) return;
    const a = document.createElement("a");
    a.href = out.toDataURL("image/png");
    a.download = "transit-map.png";
    a.click();
  }

  function exportMapPdf() {
    const out = buildExportCanvas();
    if (!out) return;
    const dataUrl = out.toDataURL("image/png");
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.write(`<!DOCTYPE html><html><head><title>Transit Map</title><style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#fff}img{max-width:100%;max-height:100vh;object-fit:contain}@media print{body{margin:0}img{width:100%;height:auto}}</style></head><body><img src="${dataUrl}" /></body></html>`);
    win.document.close();
    setTimeout(() => win.print(), 500);
  }

  function handleDeleteCustomLine(routeId: string) {
    const remainingRoutes = routesRef.current.filter((r) => r.id !== routeId);
    const route = routesRef.current.find((r) => r.id === routeId);
    snapshotHistory();
    // Cancel any in-progress animations for this route
    const windRaf = windingAnimRef.current.get(routeId);
    if (windRaf !== undefined) { cancelAnimationFrame(windRaf); windingAnimRef.current.delete(routeId); }
    const drawRaf = drawAnimRef.current.get(routeId);
    if (drawRaf !== undefined) { cancelAnimationFrame(drawRaf); drawAnimRef.current.delete(routeId); }
    stopShimmer(routeId);
    const map = mapRef.current;
    if (map) {
      [`route-shadow-${routeId}`, `route-outline-${routeId}`, `route-line-${routeId}`, `route-shimmer-${routeId}`, `stops-ring-${routeId}`, `stops-selected-${routeId}`, `stops-dot-${routeId}`, `stops-label-${routeId}`, `underground-line-${routeId}`, `portals-dot-${routeId}`].forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      [`route-${routeId}`, `stops-${routeId}`, `underground-${routeId}`, `portals-${routeId}`].forEach((id) => {
        if (map.getSource(id)) map.removeSource(id);
      });
    }
    setRoutes((prev) => prev.filter((r) => r.id !== routeId));
    trackEvent("Line Deleted", {
      ...getAnalyticsContext(remainingRoutes),
      route_id: routeId,
      route_name: route?.name,
      route_type: route?.type,
    });
    if (addStationToLine === routeId) setAddStationToLine(null);
    if (addPortalToLine === routeId) setAddPortalToLine(null);
    setSelectedRouteId(null);
    setSelectedStop(null);
  }

  /** Delete exactly one stop, identified by id — never "the first one that shares this name". */
  function handleDeleteStop(stopId: string, routeId: string) {
    const route = routesRef.current.find((r) => r.id === routeId);
    const stopName = route?.stops.find((s) => s.id === stopId)?.name;
    snapshotHistory();
    setRoutes((prev) =>
      prev.map((r) => {
        if (r.id !== routeId) return r;
        const stops = r.stops.filter((s) => s.id !== stopId);
        if (stops.length === r.stops.length) return r;
        return { ...r, shape: undefined, stops };
      })
    );
    trackEvent("Station Deleted", {
      ...getAnalyticsContext(),
      route_id: routeId,
      route_name: route?.name,
      route_type: route?.type,
      stop_name: stopName,
    });
  }

  /**
   * Delete a station from every line that serves it.
   *
   * Takes explicit (routeId, stopId) targets rather than a name: the caller
   * already knows which stops are genuine transfer counterparts (co-located,
   * via transferCounterparts) and passes exactly those. The old name-matching
   * version removed one stop per route from *any* route with a matching name,
   * which is how deleting one station wiped stops off unrelated lines.
   */
  function handleDeleteStopsFromRoutes(targets: { routeId: string; stopId: string }[]) {
    if (targets.length === 0) return;
    const byRoute = new Map<string, Set<string>>();
    for (const t of targets) {
      if (!byRoute.has(t.routeId)) byRoute.set(t.routeId, new Set());
      byRoute.get(t.routeId)!.add(t.stopId);
    }
    snapshotHistory();
    setRoutes((prev) =>
      prev.map((r) => {
        const ids = byRoute.get(r.id);
        if (!ids) return r;
        const stops = r.stops.filter((s) => !s.id || !ids.has(s.id));
        if (stops.length === r.stops.length) return r;
        return { ...r, shape: undefined, stops };
      })
    );
    setGeneratedRoute((r) => {
      if (!r) return r;
      const ids = byRoute.get(r.id);
      if (!ids) return r;
      const stops = r.stops.filter((s) => !s.id || !ids.has(s.id));
      if (stops.length === r.stops.length) return r;
      return { ...r, stops };
    });
  }

  function handleToggleStop(name: string) {
    setDisabledStops((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // ── init map
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    mapboxgl.accessToken = TOKEN;
    console.log(TOKEN, "my token")

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: (() => {
        const stored = localStorage.getItem("darkMode");
        const dark = stored !== null ? stored === "1" : window.matchMedia("(prefers-color-scheme: dark)").matches;
        return dark ? "mapbox://styles/mapbox/dark-v11" : "mapbox://styles/mapbox/light-v11";
      })(),
      center: TORONTO,
      zoom: 11.5,
      pitch: 40,
      bearing: -10,
      antialias: true,
      preserveDrawingBuffer: true,
    });

    mapRef.current = map;
    console.log(mapRef.current)

    const draw = new MapboxDraw({
      displayControlsDefault: false,
      styles: [
        {
          id: "gl-draw-polygon-fill",
          type: "fill",
          filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
          paint: { "fill-color": "#6366f1", "fill-opacity": 0.1 },
        },
        {
          id: "gl-draw-polygon-stroke",
          type: "line",
          filter: ["all", ["==", "$type", "Polygon"], ["!=", "mode", "static"]],
          paint: { "line-color": "#6366f1", "line-width": 2, "line-dasharray": [3, 2] },
        },
        {
          id: "gl-draw-point-outer",
          type: "circle",
          filter: ["all", ["==", "$type", "Point"], ["==", "meta", "vertex"]],
          paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": "#6366f1", "circle-stroke-width": 2 },
        },
        {
          id: "gl-draw-point-midpoint",
          type: "circle",
          filter: ["all", ["==", "$type", "Point"], ["==", "meta", "midpoint"]],
          paint: { "circle-radius": 3, "circle-color": "#6366f1" },
        },
      ],
    });
    drawRef.current = draw;
    map.addControl(draw as unknown as mapboxgl.IControl);

    map.on("draw.create", (e: { features: GeoJSON.Feature[] }) => {
      const feature = e.features[0];
      if (feature?.geometry.type === "Polygon") setHasBoundary(true);
      // Do NOT call draw.changeMode() here — MapboxDraw already transitions
      // internally. Calling it again can re-trigger draw mode.
      setDrawMode("normal");
      drawModeRef.current = "normal";
      justCompletedBoundaryRef.current = true;
      setTimeout(() => { justCompletedBoundaryRef.current = false; }, 300);
    });

    map.on("draw.delete", () => {
      const all = draw.getAll();
      setHasBoundary(all.features.some((f) => f.geometry.type === "Polygon"));
    });

    // NavigationControl replaced by custom React panel below
    map.addControl(new mapboxgl.ScaleControl({ unit: imperial ? "imperial" : "metric" }), "bottom-left");

    // 📖 Learn: fetch starts here (before map load) so it's already in-flight.
    // When the load handler fires, we .then() onto the same promise instead of
    // passing the URL string to addSource — avoiding a second network request.
    const neighbourhoodFetch = fetch("/Neighbourhoods - 4326.geojson")
      .then((r) => r.json() as Promise<GeoJSON.FeatureCollection>);

    map.on("load", () => {
      const firstLabelLayer = map
        .getStyle()
        ?.layers?.find(
          (l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"],
        )?.id;

      // ── Neighbourhood fill/border layers (below routes)
      void neighbourhoodFetch.then((neighbourhoodData: GeoJSON.FeatureCollection) => {
        neighbourhoodsGeoJSONRef.current = neighbourhoodData;
        map.addSource("neighbourhoods", {
          type: "geojson",
          data: neighbourhoodData,
          promoteId: "AREA_SHORT_CODE",
        });

        map.addLayer(
          {
            id: "neighbourhood-fill",
          type: "fill",
          source: "neighbourhoods",
          paint: {
            "fill-color": [
              "case",
              ["boolean", ["feature-state", "brief"], false],
              "#c2410c",
              ["boolean", ["feature-state", "selected"], false],
              "#6366f1",
              "#94a3b8",
            ],
            "fill-opacity": [
              "case",
              ["boolean", ["feature-state", "brief"], false],
              0.12,
              ["boolean", ["feature-state", "selected"], false],
              0.3,
              ["boolean", ["feature-state", "hovered"], false],
              0.08,
              0.02,
            ],
          },
        },
        firstLabelLayer,
      );

      map.addLayer(
        {
          id: "neighbourhood-border",
          type: "line",
          source: "neighbourhoods",
          paint: {
            "line-color": [
              "case",
              ["boolean", ["feature-state", "brief"], false],
              "#ea580c",
              ["boolean", ["feature-state", "selected"], false],
              "#6366f1",
              "#94a3b8",
            ],
            "line-width": [
              "case",
              ["boolean", ["feature-state", "brief"], false],
              2,
              ["boolean", ["feature-state", "selected"], false],
              3,
              0.5,
            ],
            "line-opacity": [
              "case",
              ["boolean", ["feature-state", "brief"], false],
              0.9,
              ["boolean", ["feature-state", "selected"], false],
              1,
              0.3,
            ],
            "line-dasharray": [
              "case",
              ["boolean", ["feature-state", "brief"], false],
              ["literal", [2, 1.5]],
              ["literal", [1, 0]],
            ],
          },
        },
        firstLabelLayer,
      );

      // Neighbourhood click handler — only active in "select" mode
      let hoveredNeighbourhoodId: string | null = null;

      map.on("mousemove", "neighbourhood-fill", (e) => {
        if (drawModeRef.current !== "select") return;
        map.getCanvas().style.cursor = "pointer";
        const id = e.features?.[0]?.properties?.AREA_SHORT_CODE as string | undefined;
        if (!id) return;
        if (hoveredNeighbourhoodId && hoveredNeighbourhoodId !== id) {
          map.setFeatureState(
            { source: "neighbourhoods", id: hoveredNeighbourhoodId },
            { hovered: false },
          );
        }
        hoveredNeighbourhoodId = id;
        map.setFeatureState({ source: "neighbourhoods", id }, { hovered: true });
      });

      map.on("mouseleave", "neighbourhood-fill", () => {
        map.getCanvas().style.cursor = "";
        if (hoveredNeighbourhoodId) {
          map.setFeatureState(
            { source: "neighbourhoods", id: hoveredNeighbourhoodId },
            { hovered: false },
          );
          hoveredNeighbourhoodId = null;
        }
      });

      map.on("click", "neighbourhood-fill", (e) => {
        if (drawModeRef.current !== "select") return; // "normal" and "boundary" don't select
        if (justCompletedBoundaryRef.current) return;
        if (councilHasRunRef.current) return; // locked after Generate Route
        // Station dots sit on top of neighbourhoods — let the station handler take priority
        if (map.queryRenderedFeatures(e.point, { layers: stopDotLayerIdsRef.current }).length > 0) return;
        const id = e.features?.[0]?.properties?.AREA_SHORT_CODE as string | undefined;
        if (!id) return;
        const name = e.features?.[0]?.properties?.AREA_NAME as string | undefined;

        const current = selectedNeighbourhoodsRef.current;

        if (current.has(id)) {
          // Deselect this neighbourhood — clear the panel
          setFocusedNeighbourhood(null);
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false, brief: false });
          setSelectedNeighbourhoods((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } else {
          // Select — show panel for clicked neighbourhood
          const feat = neighbourhoodsGeoJSONRef.current?.features.find(
            (f) => f.properties?.AREA_SHORT_CODE === id
          );
          setFocusedNeighbourhood({ id, name: name ?? id, lat: e.lngLat.lat, lng: e.lngLat.lng, geometry: feat?.geometry ?? null });
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: true, brief: false });
          setSelectedNeighbourhoods((prev) => new Set([...prev, id]));
        }

        // Stop propagation so route line clicks don't fire
          e.preventDefault();
        });
      }).catch(console.error);

      // 3D buildings
      map.addLayer(
        {
          id: "3d-buildings",
          source: "composite",
          "source-layer": "building",
          filter: ["==", "extrude", "true"],
          type: "fill-extrusion",
          minzoom: 12,
          paint: {
            "fill-extrusion-color": "#e8e0d4",
            "fill-extrusion-height": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "height"],
            ],
            "fill-extrusion-base": [
              "interpolate",
              ["linear"],
              ["zoom"],
              12,
              0,
              12.05,
              ["get", "min_height"],
            ],
            "fill-extrusion-opacity": 0.7,
          },
        },
        firstLabelLayer,
      );

      // Population heatmap — initialize with empty data, then sync via effect
      // Guard: useHeatmap may have already added this source if style.load fired first
      if (!map.getSource("population")) {
        map.addSource("population", {
          type: "geojson",
          data: { type: "FeatureCollection" as const, features: [] },
        });

        // Population heatmap — fades out as you zoom in
        map.addLayer(
          {
            id: "population-heatmap",
            type: "heatmap",
            source: "population",
            paint: {
              "heatmap-weight": ["interpolate", ["linear"], ["get", "weight"], 0, 0, 1, 1],
              "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 13, 0.8],
              "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 12, 28, 13, 50],
              "heatmap-color": [
                "interpolate", ["linear"], ["heatmap-density"],
                0,    "rgba(0,0,0,0)",
                0.2,  "rgba(0,104,55,0.15)",
                0.4,  "rgba(102,189,99,0.5)",
                0.6,  "rgba(255,255,51,0.8)",
                0.8,  "rgba(253,141,60,0.9)",
                1,    "rgba(215,25,28,1)",
              ],
              "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0, 10, 0.75, 13, 0.3, 15, 0],
            },
          },
          firstLabelLayer,
        );

        // Population circle points — fade in as you zoom in past the heatmap
        map.addLayer(
          {
            id: "population-points",
            type: "circle",
            source: "population",
            minzoom: 12,
            paint: {
              "circle-radius": [
                "interpolate", ["linear"], ["zoom"],
                15, 2,
                17, 4,
                19, 8,
              ],
              "circle-color": [
                "interpolate", ["linear"], ["get", "weight"],
                0,    "rgb(0,104,55)",
                0.3,  "rgb(102,189,99)",
                0.5,  "rgb(255,255,51)",
                0.7,  "rgb(253,141,60)",
                0.85, "rgb(253,141,60)",
                1,    "rgb(215,25,28)",
              ],
              "circle-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 17, 0.75],
              "circle-stroke-width": 0.5,
              "circle-stroke-color": "rgba(255,255,255,0.5)",
            },
          },
          firstLabelLayer,
        );
      }

      // Canada population density — served as XYZ vector tiles from PMTiles file
      map.addSource("canada-pop", {
        type: "vector",
        tiles: [`${window.location.origin}/api/canada-pop-tiles/{z}/{x}/{y}`],
        minzoom: 2,
        maxzoom: 12,
      });
      map.addLayer(
        {
          id: "canada-pop-heatmap",
          type: "heatmap",
          source: "canada-pop",
          "source-layer": "canada_pop",
          layout: { visibility: "none" },
          paint: {
            // d = raw density (people/km²). Use log1p approximation via stops.
            // d=1→~0.05, d=10→~0.2, d=100→~0.5, d=1000→~0.8, d=10000→1
            "heatmap-weight": ["interpolate", ["linear"], ["get", "d"], 0, 0, 10, 0.2, 100, 0.5, 1000, 0.8, 10000, 1],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 2, 0.15, 5, 0.4, 8, 1.0, 11, 2.0, 13, 3.0],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 2, 3, 5, 8, 8, 25, 10, 50, 12, 80],
            "heatmap-color": [
              "interpolate", ["linear"], ["heatmap-density"],
              0,    "rgba(0,0,0,0)",
              0.1,  "rgba(0,104,55,0.25)",
              0.25, "rgba(102,189,99,0.6)",
              0.45, "rgba(255,255,51,0.85)",
              0.65, "rgba(253,141,60,0.95)",
              1,    "rgba(215,25,28,1)",
            ],
            "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.8, 9, 0.75, 12, 0.5, 14, 0],
          },
        },
        firstLabelLayer,
      );

      // Traffic lines — initialize with empty data, then sync via effect
      // Guard: useTraffic may have already added this source if style.load fired first
      if (!map.getSource("traffic")) {
        map.addSource("traffic", {
          type: "geojson",
          data: { type: "FeatureCollection" as const, features: [] },
        });

        map.addLayer(
          {
            id: "traffic-lines",
            type: "line",
            source: "traffic",
            layout: { "line-join": "round", "line-cap": "round", visibility: "none" },
            paint: {
              "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 4],
              "line-color": [
                "case",
                ["!=", ["get", "avg_traffic"], null],
                [
                  "match",
                  ["get", "traffic_color"],
                  "green",
                  "#22c55e",
                  "yellow",
                  "#f59e0b",
                  "red",
                  "#ef4444",
                  "#22c55e"
                ],
                "#22c55e"
              ],

              "line-opacity": 0.5,
            },
          },
          firstLabelLayer,
        );
      }

      // ── Shared bus layers (2 GeoJSON sources, 4 layers — replaces per-route bus layers)
      const visibleBusRouteIds = new Set(
        BUS_ROUTES.filter((r) => !hiddenRoutes.has(r.id)).map((r) => r.id),
      );
      const busLinesFeatures: GeoJSON.Feature<GeoJSON.LineString>[] = BUS_ROUTES.map((r, idx) => ({
        type: "Feature" as const,
        id: idx,
        properties: { routeId: r.id, color: r.color },
        geometry: {
          type: "LineString" as const,
          coordinates: (r.shape ?? r.stops.map((s) => s.coords)),
        },
      }));
      const busStopsFeatures: GeoJSON.Feature<GeoJSON.Point>[] = BUS_ROUTES.flatMap((r) =>
        r.stops.map((s) => ({
          type: "Feature" as const,
          properties: { stopId: s.id, routeId: r.id, color: r.color, name: s.name },
          geometry: { type: "Point" as const, coordinates: s.coords },
        })),
      );
      const hiddenBusIds = BUS_ROUTES.map((r) => r.id).filter((id) => !visibleBusRouteIds.has(id));
      const busFilter: mapboxgl.FilterSpecification =
        hiddenBusIds.length > 0
          ? ["!", ["in", ["get", "routeId"], ["literal", hiddenBusIds]]]
          : ["literal", true];

      map.addSource("bus-lines-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: busLinesFeatures },
      });
      map.addSource("bus-stops-source", {
        type: "geojson",
        data: { type: "FeatureCollection", features: busStopsFeatures },
      });

      map.addLayer({
        id: "bus-line-shadow",
        type: "line",
        source: "bus-lines-source",
        filter: busFilter,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"] as unknown as string,
          "line-opacity": 0.08,
          "line-width": 5,
          "line-blur": 3,
        },
      });

      map.addLayer({
        id: "bus-line-layer",
        type: "line",
        source: "bus-lines-source",
        filter: busFilter,
        layout: { "line-join": "round", "line-cap": "round" },
        paint: {
          "line-color": ["get", "color"] as unknown as string,
          "line-opacity": ["case", ["boolean", ["feature-state", "hovered"], false], 1.0, 0.7] as unknown as number,
          "line-width": ["case", ["boolean", ["feature-state", "hovered"], false], 4, 2] as unknown as number,
        },
      });

      map.addLayer({
        id: "bus-stops-ring",
        type: "circle",
        source: "bus-stops-source",
        filter: busFilter,
        minzoom: 14,
        paint: {
          "circle-color": ["get", "color"] as unknown as string,
          "circle-opacity": 0.5,
          "circle-radius": 2.5,
        },
      });

      map.addLayer({
        id: "bus-stops-dot",
        type: "circle",
        source: "bus-stops-source",
        filter: busFilter,
        minzoom: 14,
        paint: {
          "circle-color": "#ffffff",
          "circle-stroke-color": ["get", "color"] as unknown as string,
          "circle-radius": 1.5,
          "circle-stroke-width": 1,
        },
      });

      map.addLayer({
        id: "bus-stops-label",
        type: "symbol",
        source: "bus-stops-source",
        filter: busFilter,
        minzoom: 14,
        layout: {
          "text-field": ["get", "name"] as unknown as string,
          "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"],
          "text-size": 8,
          "text-offset": [0, 1],
          "text-anchor": "top",
          "text-optional": true,
          "visibility": "none",
        },
        paint: {
          "text-color": ["get", "color"] as unknown as string,
          "text-halo-color": darkMode ? "#111111" : "#ffffff",
          "text-halo-width": 1.5,
        },
      });

      // Click handler on shared bus stop dot layer
      map.on("click", "bus-stops-dot", (e) => {
        if (didDragStopRef.current) { didDragStopRef.current = false; return; }
        const props = e.features?.[0]?.properties as { stopId?: string; name?: string; routeId?: string } | undefined;
        const name = props?.name;
        const routeId = props?.routeId;
        const stopId = props?.stopId;
        if (!name || !routeId || !stopId) return;
        if (!addStationToLineRef.current) e.originalEvent.stopPropagation();
        if (drawModeRef.current === "select") {
          const key = `${name}::${routeId}`;
          const next = new Set(selectedStationsRef.current);
          if (next.has(key)) next.delete(key); else next.add(key);
          selectedStationsRef.current = next;
          setSelectedStations(new Set(next));
          return;
        }
        const busRoute = BUS_ROUTES.find((r) => r.id === routeId);
        if (!busRoute) return;
        const { x, y } = e.point;
        setStationPopup({ stopId, name, routeId, x, y, coords: [e.lngLat.lng, e.lngLat.lat] });
        setSelectedRouteId(busRoute.id);
        setSelectedStop(stopId);
      });

      map.on("mouseenter", "bus-stops-dot", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "bus-stops-dot", () => { map.getCanvas().style.cursor = ""; });

      map.on("click", "bus-line-layer", (e) => {
        const routeId = e.features?.[0]?.properties?.routeId as string | undefined;
        const busRoute = BUS_ROUTES.find((r) => r.id === routeId);
        if (busRoute) { setSelectedRouteId(busRoute.id); setSelectedStop(null); }
      });

      let hoveredBusFeatureId: number | string | null = null;

      map.on("mousemove", "bus-line-layer", (e) => {
        const featureId = e.features?.[0]?.id;
        if (featureId === undefined || featureId === null) return;
        map.getCanvas().style.cursor = "pointer";
        if (featureId !== hoveredBusFeatureId) {
          if (hoveredBusFeatureId !== null) {
            map.setFeatureState({ source: "bus-lines-source", id: hoveredBusFeatureId }, { hovered: false });
          }
          hoveredBusFeatureId = featureId;
          map.setFeatureState({ source: "bus-lines-source", id: featureId }, { hovered: true });
        }
      });

      map.on("mouseleave", "bus-line-layer", () => {
        map.getCanvas().style.cursor = "";
        if (hoveredBusFeatureId !== null) {
          map.setFeatureState({ source: "bus-lines-source", id: hoveredBusFeatureId }, { hovered: false });
          hoveredBusFeatureId = null;
        }
      });


      // Map-level click: add station to selected line, or close popup
      map.on("click", (e) => {
        handleIsochroneOriginPicking(map, e);

        // Measure tool intercepts first
        if (measureModeRef.current) {
          const pt: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          if (measurePtsRef.current.length === 0) {
            measurePtsRef.current = [pt];
          } else {
            const a = measurePtsRef.current[0]!;
            measurePtsRef.current = [];
            const pts: [[number, number], [number, number]] = [a, pt];
            setMeasurePoints(pts);
            const dx = pts[1][0] - pts[0][0], dy = pts[1][1] - pts[0][1];
            const dist = Math.sqrt(dx * dx + dy * dy) * 111.32 * Math.cos(((pts[0][1] + pts[1][1]) / 2) * Math.PI / 180);
            setMeasureDistanceKm(Math.round(dist * 100) / 100);
          }
          return;
        }

        const stopLayers = (map.getStyle()?.layers ?? [])
          .filter((l) => l.id.startsWith("stops-dot-") || l.id === "bus-stops-dot")
          .map((l) => l.id);
        const hitStop = stopLayers.length > 0 && map.queryRenderedFeatures(e.point, { layers: stopLayers }).length > 0;

        if (!hitStop) setStationPopup(null);

        const lineId = addStationToLineRef.current;
        if (lineId && !hitStop) {
          const coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          const currentCounter = stopCounterRef.current;
          const tempName = `Station ${currentCounter}`;
          const newStopIdValue = newStopId();
          const routeBeforeAdd = routesRef.current.find((r) => r.id === lineId);
          snapshotHistory();
          stopCounterRef.current = currentCounter + 1;
          setRoutes((prev) => prev.map((r) => {
            if (r.id !== lineId) return r;
            const newStop = { id: newStopIdValue, name: tempName, coords };
            if (r.stops.length === 0) return { ...r, shape: undefined, stops: [newStop] };
            const insertIdx = bestInsertIndex(coords, r.stops);
            const newStops = [...r.stops.slice(0, insertIdx), newStop, ...r.stops.slice(insertIdx)];
            const roadSnapped = r.type === "bus" || r.type === "streetcar";
            return { ...r, stops: newStops, shape: roadSnapped ? r.shape : undefined };
          }));
          trackEvent("Station Added", {
            ...getAnalyticsContext(),
            route_id: lineId,
            route_name: routeBeforeAdd?.name,
            route_type: routeBeforeAdd?.type,
            stop_name: tempName,
            lng: Number(coords[0].toFixed(5)),
            lat: Number(coords[1].toFixed(5)),
          });
          // Auto-snap bus and streetcar routes to roads after each stop placement
          if ((routeBeforeAdd?.type === "bus" || routeBeforeAdd?.type === "streetcar") && routeBeforeAdd.stops.length >= 1) {
            startShimmerRef.current(lineId);
            triggerAutoSnapRef.current(lineId);
          }
          // Geocode asynchronously and rename from temp name
          void reverseGeocodeStation(coords[0], coords[1]).then((geoName) => {
            if (!geoName) return;
            setRoutes((prev) => {
              // Suffixing duplicates is now purely cosmetic — identity lives in
              // stop.id, so a repeated name no longer breaks anything. It just
              // keeps the two "Yonge St" stops on a line tellable apart by eye.
              const allStopNames = new Set(prev.flatMap((r) => r.stops.map((s) => s.name)));
              let finalName = geoName;
              if (allStopNames.has(finalName)) {
                let n = 2;
                while (allStopNames.has(`${geoName} (${n})`)) n++;
                finalName = `${geoName} (${n})`;
              }
              return prev.map((r) =>
                r.id === lineId ? { ...r, stops: r.stops.map(s => s.id === newStopIdValue ? { ...s, name: finalName } : s) } : r
              );
            });
          });
          return;
        }

        // Portal placement mode
        const portalLineId = addPortalToLineRef.current;
        if (portalLineId) {
          const coords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
          const route = routesRef.current.find((r) => r.id === portalLineId);
          snapshotHistory();
          setRoutes((prev) => prev.map((r) => {
            if (r.id !== portalLineId) return r;
            // Snap portal coord to route shape
            const shape = r.shape ?? r.stops.map((s) => s.coords);
            const snapped = shape.length >= 2 ? snapToShape(coords, shape) : coords;
            return { ...r, portals: [...(r.portals ?? []), { coords: snapped }] };
          }));
          trackEvent("Portal Added", {
            ...getAnalyticsContext(),
            route_id: portalLineId,
            route_name: route?.name,
            route_type: route?.type,
            lng: Number(coords[0].toFixed(5)),
            lat: Number(coords[1].toFixed(5)),
          });
        }
      });

      // Close popup when map moves
      map.on("move", () => setStationPopup(null));

      // Double-click exits add-station mode
      map.on("dblclick", (e) => {
        if (addStationToLineRef.current) {
          e.preventDefault();
          setAddStationToLine(null);
        }
      });

      // Right-click → context menu with "Ask AI about here". We look up the
      // enclosing neighbourhood (if any) from the already-loaded geo data so
      // we can label the menu with something meaningful instead of raw coords.
      // 📖 Learn: Mapbox emits `contextmenu` for right-clicks. Calling
      // e.preventDefault() suppresses the browser's native menu. e.point gives
      // pixel coords inside the map canvas — we add the canvas offset to get
      // viewport-relative coords for positioning the menu.
      map.on("contextmenu", (e) => {
        e.preventDefault();
        const lng = e.lngLat.lng;
        const lat = e.lngLat.lat;
        const canvas = map.getCanvasContainer();
        const rect = canvas.getBoundingClientRect();
        let neighbourhood: string | null = null;
        const feats = neighbourhoodsGeoJSONRef.current?.features;
        if (feats) {
          for (const f of feats) {
            if (f.geometry && pointInGeometry([lng, lat], f.geometry)) {
              neighbourhood = (f.properties?.AREA_NAME as string | undefined) ?? null;
              break;
            }
          }
        }
        setMapCtxMenu({
          lat, lng,
          x: rect.left + e.point.x,
          y: rect.top + e.point.y,
          neighbourhood,
        });
      });
      // Any subsequent map interaction dismisses the menu.
      map.on("movestart", () => setMapCtxMenu(null));
      map.on("click", () => setMapCtxMenu(null));

      // Pre-load GO rail shapes so routes render with real track geometry on first paint
      fetch("/gotransit/go-rail-shapes.geojson")
        .then((r) => r.json())
        .then((geojson: { features: Array<{ properties: { variant_id: string }; geometry: { coordinates: [number, number][] } }> }) => {
          const shapeByVariant = new Map<string, [number, number][]>();
          for (const f of geojson.features) shapeByVariant.set(f.properties.variant_id, f.geometry.coordinates);
          goShapesRef.current = shapeByVariant;
          setRoutes((prev) => applyGoShapes(prev));
        })
        .catch((e) => console.warn("[go-shapes] pre-load failed", e))
        .finally(() => setMapLoaded(true));
    });

    // Escape cancels an in-progress boundary draw
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Always dismiss the map context menu first (no state guard needed —
        // setting to null when already null is a no-op).
        setMapCtxMenu(null);
      }
      if (e.key === "Enter" && addStationToLineRef.current) {
        setAddStationToLine(null);
        return;
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        const popup = stationPopupRef.current;
        if (!popup) return;
        if (!routesRef.current.some((r) => r.id === popup.routeId)) return;
        e.preventDefault();
        handleDeleteStop(popup.stopId, popup.routeId);
        setStationPopup(null);
        return;
      }
      if (e.key === "Escape" && drawModeRef.current === "boundary") {
        draw.deleteAll();
        draw.changeMode("simple_select");
        setHasBoundary(false);
        setDrawMode("normal");
        drawModeRef.current = "normal";
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        // Delegate to the same functions the toolbar buttons use. These used to
        // be inline copies that only restored routes+counter, so Cmd+Z quietly
        // dropped anything else in the snapshot. Safe to call from this
        // once-installed listener: they touch only refs and stable setters.
        handleUndo();
      } else if (e.key === "z" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        handleRedo();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      map.remove();
      mapRef.current = null;
    };
  }, []);



  // ── Canada population density visibility toggle (PMTiles — no fetch needed)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (map.getLayer("canada-pop-heatmap")) {
      map.setLayoutProperty("canada-pop-heatmap", "visibility", showCanadaPop ? "visible" : "none");
    }
  }, [showCanadaPop, mapLoaded]);


  // ── per-route visibility toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const prev = prevHiddenRef.current;

    // Bus routes: use a single setFilter on the shared bus layers
    // Exclude both hidden routes AND routes that have been promoted to the editable routes state
    const excludedBusIds = BUS_ROUTES.map((r) => r.id).filter((id) => hiddenRoutes.has(id) || routesRef.current.some((r) => r.id === id));
    const busFilter: mapboxgl.FilterSpecification =
      excludedBusIds.length > 0
        ? ["!", ["in", ["get", "routeId"], ["literal", excludedBusIds]]]
        : ["literal", true];
    for (const layerId of ["bus-line-shadow", "bus-line-layer", "bus-stops-ring", "bus-stops-dot"]) {
      if (map.getLayer(layerId)) map.setFilter(layerId, busFilter);
    }

    // Non-bus routes: cover all routes in the unified model
    for (const route of routesRef.current) {
      const wasHidden = prev.has(route.id);
      const isHidden  = hiddenRoutes.has(route.id);
      if (wasHidden === isHidden) continue;
      const vis = isHidden ? "none" : "visible";
      for (const layerId of [`route-shadow-${route.id}`, `route-outline-${route.id}`, `route-line-${route.id}`, `stops-ring-${route.id}`, `stops-selected-${route.id}`, `stops-dot-${route.id}`, `stops-label-${route.id}`]) {
        if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", vis);
      }
    }

    prevHiddenRef.current = new Set(hiddenRoutes);
  }, [hiddenRoutes, routes, mapLoaded]);

  // ── coverage zones overlay ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SOURCE = "coverage-zones";
    const LAYER = "coverage-circles";
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    if (!showCoverageZones) return;
    const features = routes.flatMap((r) =>
      r.stops.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: s.coords },
        properties: { color: r.color },
      }))
    );
    map.addSource(SOURCE, {
      type: "geojson",
      data: { type: "FeatureCollection", features },
    });
    const beforeId = map.getLayer("neighbourhood-fill") ? "neighbourhood-fill" : undefined;
    map.addLayer(
      {
        id: LAYER,
        type: "circle",
        source: SOURCE,
        paint: {
          "circle-radius": [
            "interpolate", ["linear"], ["zoom"],
            9, 4, 11, 9, 13, 30, 15, 110,
          ],
          "circle-color": "#0ea5e9",
          "circle-opacity": 0.08,
          "circle-stroke-color": "#0ea5e9",
          "circle-stroke-width": 1,
          "circle-stroke-opacity": 0.25,
        },
      },
      beforeId,
    );
  }, [showCoverageZones, routes, mapLoaded]);

  // ── AI map annotations (from Ask AI tool calls) ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const HIGHLIGHT_SRC = "ai-highlights";
    const CORRIDOR_SRC = "ai-corridors";
    const PIN_SRC = "ai-pins";
    const HIGHLIGHT_FILL = "ai-highlights-fill";
    const HIGHLIGHT_LINE = "ai-highlights-line";
    const CORRIDOR_LINE = "ai-corridors-line";
    const PIN_LAYER = "ai-pins-layer";
    const PIN_LABEL = "ai-pins-label";

    // Separate pill images per theme so the chip background matches the map.
    // Registered lazily (addImage throws if the id already exists).
    const PILL_IMG = darkMode ? "ai-pill-dark" : "ai-pill-light";
    if (!map.hasImage(PILL_IMG)) {
      const pill = makePillImage(
        darkMode ? "rgba(28,25,23,0.92)" : "rgba(255,255,255,0.96)", // stone-900 / white
        darkMode ? "rgba(120,113,108,0.45)" : "rgba(168,162,158,0.5)", // stone border
      );
      map.addImage(PILL_IMG, pill.data, pill.options);
    }

    const removeAll = () => {
      for (const id of [PIN_LABEL, PIN_LAYER, CORRIDOR_LINE, HIGHLIGHT_LINE, HIGHLIGHT_FILL]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [PIN_SRC, CORRIDOR_SRC, HIGHLIGHT_SRC]) {
        if (map.getSource(id)) map.removeSource(id);
      }
    };

    if (!aiAnnotationsVisible || aiAnnotations.length === 0) {
      removeAll();
      return;
    }

    const highlightFeatures: GeoJSON.Feature[] = aiAnnotations
      .filter((a) => a.kind === "highlight" && Array.isArray(a.args.polygon))
      .map((a) => {
        const ring = (a.args.polygon as number[][]).map(
          (p) => [Number(p[0]), Number(p[1])] as [number, number],
        );
        if (ring.length > 0 && (ring[0]![0] !== ring[ring.length - 1]![0] || ring[0]![1] !== ring[ring.length - 1]![1])) {
          ring.push(ring[0]!);
        }
        const colorKey = typeof a.args.color === "string" ? a.args.color : "teal";
        const fill = COLOR_HEX[colorKey] ?? a.color ?? "#14b8a6";
        return {
          type: "Feature" as const,
          geometry: { type: "Polygon" as const, coordinates: [ring] },
          properties: {
            label: a.label,
            fill,
            severity: String(a.args.severity ?? "info"),
          },
        };
      });

    const corridorFeatures: GeoJSON.Feature[] = aiAnnotations
      .filter((a) => a.kind === "corridor")
      .map((a) => {
        const from = a.args.from as number[];
        const to = a.args.to as number[];
        // Prefer the server's road-snapped path; fall back to a straight line.
        const path = Array.isArray(a.args.path)
          ? (a.args.path as number[][]).map((p) => [Number(p[0]), Number(p[1])] as [number, number])
          : null;
        return {
          type: "Feature" as const,
          geometry: {
            type: "LineString" as const,
            coordinates: path && path.length >= 2
              ? path
              : ([
                  [Number(from[0]), Number(from[1])],
                  [Number(to[0]), Number(to[1])],
                ] as [number, number][]),
          },
          properties: {
            label: a.label,
            color: a.color ?? "#0d9488",
            mode: String(a.args.mode ?? "bus"),
          },
        };
      });

    const pinFeatures: GeoJSON.Feature[] = aiAnnotations
      .filter((a) => a.kind === "pin")
      .map((a) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [Number(a.args.lng), Number(a.args.lat)],
        },
        // Truncate long AI labels so the on-map text stays a tidy short tag
        // instead of a cramped multi-line block. Full text lives in the chat chip.
        properties: { note: a.label.length > 24 ? a.label.slice(0, 22).trimEnd() + "…" : a.label, icon: a.args.icon ?? "info", color: a.color ?? "#14b8a6" },
      }));

    // All AI overlay layers are added with NO beforeId, so they land on the very
    // TOP of the map — above the route lines and every basemap label. These are
    // annotations the user explicitly asked the AI to draw, so they always win
    // the z-order. (The route re-stack effect anchors its moves at the lowest of
    // these via aiOverlayFloor(), so route layers can never rise above them.)
    if (map.getSource(HIGHLIGHT_SRC)) {
      (map.getSource(HIGHLIGHT_SRC) as mapboxgl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: highlightFeatures,
      });
    } else {
      map.addSource(HIGHLIGHT_SRC, {
        type: "geojson",
        data: { type: "FeatureCollection", features: highlightFeatures },
      });
      map.addLayer(
        {
          id: HIGHLIGHT_FILL,
          type: "fill",
          source: HIGHLIGHT_SRC,
          paint: {
            "fill-color": ["get", "fill"],
            "fill-opacity": 0.25,
          },
        },
      );
      map.addLayer(
        {
          id: HIGHLIGHT_LINE,
          type: "line",
          source: HIGHLIGHT_SRC,
          paint: {
            "line-color": ["get", "fill"],
            "line-width": 2,
            "line-opacity": 0.7,
          },
        },
      );
    }

    if (map.getSource(CORRIDOR_SRC)) {
      (map.getSource(CORRIDOR_SRC) as mapboxgl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: corridorFeatures,
      });
    } else {
      map.addSource(CORRIDOR_SRC, {
        type: "geojson",
        data: { type: "FeatureCollection", features: corridorFeatures },
      });
      map.addLayer(
        {
          id: CORRIDOR_LINE,
          type: "line",
          source: CORRIDOR_SRC,
          paint: {
            "line-color": ["get", "color"],
            "line-width": 4,
            "line-opacity": 0.85,
            "line-dasharray": [2, 1],
          },
        },
      );
    }

    // Update (or create) the source data in place.
    if (map.getSource(PIN_SRC)) {
      (map.getSource(PIN_SRC) as mapboxgl.GeoJSONSource).setData({
        type: "FeatureCollection",
        features: pinFeatures,
      });
    } else {
      map.addSource(PIN_SRC, {
        type: "geojson",
        data: { type: "FeatureCollection", features: pinFeatures },
      });
    }

    // ALWAYS rebuild the pin + label layers from scratch. Patching layout
    // props on a long-lived layer proved unreliable (a layer created with the
    // old "text-anchor: top" kept rendering below). Tearing down and re-adding
    // guarantees the current config — including the "above the pin" placement
    // and the theme's pill image — actually takes effect.
    if (map.getLayer(PIN_LABEL)) map.removeLayer(PIN_LABEL);
    if (map.getLayer(PIN_LAYER)) map.removeLayer(PIN_LAYER);

    // The pin dot + pill label are added with NO beforeId, so they land on
    // TOP of every other layer. These are AI annotations the user explicitly
    // asked to see, so they must always sit above the route lines.
    //
    // Earlier they were inserted at `beforeId: neighbourhood-fill`, which put
    // them BELOW the route lines whenever that layer already existed. Because
    // `beforeId` is only set when neighbourhood-fill is present at run time,
    // the result was nondeterministic: pills drawn mid-session (layer present)
    // were buried under the lines, but after a refresh (effect runs before the
    // neighbourhood layer exists → beforeId undefined → added on top) they
    // looked correct. Omitting beforeId removes that timing dependency.
    // 📖 Learn: addLayer(layer) with no beforeId appends to the very top;
    //   addLayer(layer, beforeId) inserts directly *below* beforeId.
    map.addLayer({
      id: PIN_LAYER,
      type: "circle",
      source: PIN_SRC,
      paint: {
        "circle-radius": 7,
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#fff",
        "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: PIN_LABEL,
      type: "symbol",
      source: PIN_SRC,
      layout: {
        // The pill background wraps the text (icon-text-fit "both"), so we
        // get a solid rounded chip instead of bare text fighting the map.
        "icon-image": PILL_IMG,
        "icon-text-fit": "both",
        "icon-text-fit-padding": [1, 4, 1, 4],
        "icon-allow-overlap": true,
        "text-field": ["get", "note"],
        "text-size": 10.5,
        "text-max-width": 12,
        // Always ABOVE the pin (deterministic — not collision-driven).
        // text-anchor "bottom" puts the label's BOTTOM edge at the point,
        // so it rises upward; negative Y offset lifts it clear of the dot.
        "text-anchor": "bottom",
        "text-offset": [0, -1.2],
        "text-allow-overlap": true,
      },
      paint: {
        "text-color": darkMode ? "#f5f5f4" : "#292524",
      },
    });
  }, [aiAnnotations, aiAnnotationsVisible, mapLoaded, darkMode]);

  // ── AI annotation editing: draggable vertex handles ─────────────────────────
  // Two effects on purpose:
  //  (1) setup — adds the handle source/layers + drag listeners ONCE per edit
  //      session. It depends only on editing/visible/mapLoaded so an in-flight
  //      drag never tears down its own listeners.
  //  (2) data — refreshes handle positions whenever annotations change.
  const HANDLE_SRC = "ai-edit-handles";
  const HANDLE_VERTEX = "ai-edit-handles-vertex";
  const HANDLE_MIDPOINT = "ai-edit-handles-midpoint";

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const teardown = () => {
      for (const id of [HANDLE_MIDPOINT, HANDLE_VERTEX]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(HANDLE_SRC)) map.removeSource(HANDLE_SRC);
    };

    if (!aiEditing || !aiAnnotationsVisible) {
      teardown();
      return;
    }

    map.addSource(HANDLE_SRC, {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });
    // Midpoints render first (under) so the solid vertices sit on top.
    map.addLayer({
      id: HANDLE_MIDPOINT,
      type: "circle",
      source: HANDLE_SRC,
      filter: ["==", ["get", "role"], "midpoint"],
      paint: {
        "circle-radius": 4,
        "circle-color": "#fff",
        "circle-opacity": 0.6,
        "circle-stroke-color": "#14b8a6",
        "circle-stroke-width": 1,
      },
    });
    map.addLayer({
      id: HANDLE_VERTEX,
      type: "circle",
      source: HANDLE_SRC,
      filter: ["==", ["get", "role"], "vertex"],
      paint: {
        "circle-radius": 6,
        "circle-color": "#fff",
        "circle-stroke-color": "#14b8a6",
        "circle-stroke-width": 3,
      },
    });

    const findAnn = (annId: string) =>
      aiAnnotationsRef.current.find((a) => a.id === annId) ?? null;

    let dragging: { annId: string; index: number } | null = null;

    const onMove = (e: mapboxgl.MapMouseEvent) => {
      if (!dragging) return;
      const ann = findAnn(dragging.annId);
      if (!ann) return;
      const { lng, lat } = e.lngLat;
      updateAiAnnotationArgsRef.current(
        dragging.annId,
        moveVertex(ann, dragging.index, lng, lat),
      );
    };

    const onUp = () => {
      dragging = null;
      map.off("mousemove", onMove);
      map.dragPan.enable();
    };

    const onDown = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      e.preventDefault(); // stop the map from panning
      const props = f.properties as { annId: string; role: string; index: number };
      const ann = findAnn(props.annId);
      if (!ann) return;

      if (props.role === "midpoint") {
        // Insert a new corner at the midpoint, then drag that new corner.
        const next = insertVertex(ann, props.index, e.lngLat.lng, e.lngLat.lat);
        updateAiAnnotationArgsRef.current(props.annId, next);
        dragging = { annId: props.annId, index: props.index + 1 };
      } else {
        dragging = { annId: props.annId, index: props.index };
      }

      map.dragPan.disable();
      map.on("mousemove", onMove);
      map.once("mouseup", onUp);
    };

    // Double-click a corner to delete it (polygons only; keeps ≥3 corners).
    const onDblClick = (e: mapboxgl.MapLayerMouseEvent) => {
      const f = e.features?.[0];
      if (!f) return;
      const props = f.properties as { annId: string; index: number };
      const ann = findAnn(props.annId);
      if (!ann) return;
      const next = deleteVertex(ann, props.index);
      if (next) {
        e.preventDefault();
        updateAiAnnotationArgsRef.current(props.annId, next);
      }
    };

    const setGrab = () => { map.getCanvas().style.cursor = "move"; };
    const clearGrab = () => { map.getCanvas().style.cursor = ""; };

    map.on("mousedown", HANDLE_VERTEX, onDown);
    map.on("mousedown", HANDLE_MIDPOINT, onDown);
    map.on("dblclick", HANDLE_VERTEX, onDblClick);
    map.on("mouseenter", HANDLE_VERTEX, setGrab);
    map.on("mouseleave", HANDLE_VERTEX, clearGrab);
    map.on("mouseenter", HANDLE_MIDPOINT, setGrab);
    map.on("mouseleave", HANDLE_MIDPOINT, clearGrab);

    return () => {
      map.off("mousedown", HANDLE_VERTEX, onDown);
      map.off("mousedown", HANDLE_MIDPOINT, onDown);
      map.off("dblclick", HANDLE_VERTEX, onDblClick);
      map.off("mouseenter", HANDLE_VERTEX, setGrab);
      map.off("mouseleave", HANDLE_VERTEX, clearGrab);
      map.off("mouseenter", HANDLE_MIDPOINT, setGrab);
      map.off("mouseleave", HANDLE_MIDPOINT, clearGrab);
      map.off("mousemove", onMove);
      map.dragPan.enable();
      teardown();
    };
  }, [aiEditing, aiAnnotationsVisible, mapLoaded]);

  // (2) Keep handle positions in sync with the current annotations.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !aiEditing || !aiAnnotationsVisible) return;
    const src = map.getSource(HANDLE_SRC) as mapboxgl.GeoJSONSource | undefined;
    if (!src) return;
    const features: GeoJSON.Feature[] = aiAnnotations.flatMap((ann) =>
      editableVertices(ann).map((v) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [v.lng, v.lat] },
        properties: { annId: v.annId, role: v.role, index: v.index },
      })),
    );
    src.setData({ type: "FeatureCollection", features });
  }, [aiAnnotations, aiEditing, aiAnnotationsVisible, mapLoaded]);

  // Fly camera when user clicks an annotation chip or AI emits fly_to.
  const prevFlyToCountRef = useRef(0);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    if (aiFocusedId) {
      const ann = aiAnnotations.find((a) => a.id === aiFocusedId);
      const bbox = ann ? annotationBbox(ann) : null;
      if (bbox) {
        map.fitBounds(
          [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
          { padding: 48, duration: 900, maxZoom: 14 },
        );
      }
      clearAiFocus();
      return;
    }

    const flyTos = aiAnnotations.filter((a) => a.kind === "flyTo");
    if (flyTos.length > prevFlyToCountRef.current) {
      const latest = flyTos[flyTos.length - 1]!;
      const bbox = annotationBbox(latest);
      if (bbox) {
        map.fitBounds(
          [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
          { padding: 48, duration: 900, maxZoom: 14 },
        );
      }
    }
    prevFlyToCountRef.current = flyTos.length;
  }, [aiFocusedId, aiAnnotations, mapLoaded, clearAiFocus]);

  // ── service heatmap overlay ──────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SOURCE = "service-heatmap";
    const LAYER = "service-heatmap-layer";
    if (map.getLayer(LAYER)) map.removeLayer(LAYER);
    if (map.getSource(SOURCE)) map.removeSource(SOURCE);
    if (!showServiceHeatmap) return;
    const features = routes.flatMap((r) =>
      r.stops.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: s.coords },
        properties: {
          weight: r.type === "subway" || r.type === "lrt" ? 3 : r.type === "streetcar" ? 2 : 1,
        },
      }))
    );
    map.addSource(SOURCE, { type: "geojson", data: { type: "FeatureCollection", features } });
    const beforeId = map.getLayer("neighbourhood-fill") ? "neighbourhood-fill" : undefined;
    map.addLayer(
      {
        id: LAYER,
        type: "heatmap",
        source: SOURCE,
        paint: {
          "heatmap-weight": ["get", "weight"],
          "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 8, 0.5, 14, 2],
          "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 9, 15, 13, 35],
          "heatmap-color": [
            "interpolate", ["linear"], ["heatmap-density"],
            0,   "rgba(0,0,0,0)",
            0.2, "#4ade80",
            0.5, "#fbbf24",
            0.8, "#f97316",
            1,   "#ef4444",
          ],
          "heatmap-opacity": 0.65,
        },
      },
      beforeId,
    );
  }, [showServiceHeatmap, routes, mapLoaded]);

  // ── pedestrian connections ────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SRC = "pedestrian-connections-src";
    const LAYER = "pedestrian-connections-line";
    const features: GeoJSON.Feature<GeoJSON.LineString>[] = PEDESTRIAN_CONNECTIONS.flatMap((conn) => {
      const stopA = routes.find((r) => r.id === conn.routeAId)?.stops.find((s) => s.name === conn.stopAName);
      const stopB = routes.find((r) => r.id === conn.routeBId)?.stops.find((s) => s.name === conn.stopBName);
      if (!stopA || !stopB) return [];
      return [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates: [stopA.coords, stopB.coords] }, properties: {} }];
    });
    const geojson: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
    if (map.getSource(SRC)) {
      (map.getSource(SRC) as mapboxgl.GeoJSONSource).setData(geojson);
    } else {
      map.addSource(SRC, { type: "geojson", data: geojson });
      map.addLayer({ id: LAYER, type: "line", source: SRC, paint: { "line-color": "#000000", "line-width": 2, "line-dasharray": [2, 2], "line-opacity": 0.55 } });
    }
  }, [mapLoaded, routes]);

  // ── catchment circles overlay ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SRC = "catchment-src", FILL = "catchment-fill", LINE = "catchment-line";
    const cleanup = () => { [FILL, LINE].forEach((l) => { if (map.getLayer(l)) map.removeLayer(l); }); if (map.getSource(SRC)) map.removeSource(SRC); };
    cleanup();
    if (!showCatchment) return;
    const seen = new Set<string>();
    const features: GeoJSON.Feature[] = [];
    for (const r of routes) {
      if (hiddenRoutes.has(r.id)) continue;
      for (const s of r.stops) {
        const k = `${s.coords[0].toFixed(4)},${s.coords[1].toFixed(4)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [circlePolygon(s.coords, catchmentRadius)] } });
      }
    }
    map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({ id: FILL, type: "fill", source: SRC, paint: { "fill-color": "#10b981", "fill-opacity": 0.06 } });
    map.addLayer({ id: LINE, type: "line", source: SRC, paint: { "line-color": "#10b981", "line-width": 1, "line-opacity": 0.35 } });
    return cleanup;
  }, [showCatchment, catchmentRadius, routes, hiddenRoutes, mapLoaded]);

  // ── disruption buffer overlay ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SRC = "disruption-src", FILL = "disruption-fill", LINE = "disruption-line";
    const cleanup = () => { [FILL, LINE].forEach((l) => { if (map.getLayer(l)) map.removeLayer(l); }); if (map.getSource(SRC)) map.removeSource(SRC); };
    cleanup();
    if (!showDisruption) return;
    const affected = disruptionRouteId ? routes.filter((r) => r.id === disruptionRouteId) : routes.filter((r) => !hiddenRoutes.has(r.id));
    const features: GeoJSON.Feature[] = affected.flatMap((r) =>
      r.stops.map((s) => ({ type: "Feature" as const, properties: {}, geometry: { type: "Polygon" as const, coordinates: [circlePolygon(s.coords, disruptionRadius)] } }))
    );
    map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({ id: FILL, type: "fill", source: SRC, paint: { "fill-color": "#ef4444", "fill-opacity": 0.1 } });
    map.addLayer({ id: LINE, type: "line", source: SRC, paint: { "line-color": "#ef4444", "line-width": 1, "line-opacity": 0.4, "line-dasharray": [3, 2] } });
    return cleanup;
  }, [showDisruption, disruptionRadius, disruptionRouteId, routes, hiddenRoutes, mapLoaded]);

  // ── measure tool ──────────────────────────────────────────────────────────
  // Reset measure mode when the Analysis panel is closed so clicks aren't intercepted
  useEffect(() => { if (!experimentalFeatures) setMeasureMode(false); }, [experimentalFeatures]);
  useEffect(() => {
    measureModeRef.current = measureMode;
    if (!measureMode) { measurePtsRef.current = []; setMeasurePoints(null); setMeasureDistanceKm(null); }
  }, [measureMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    const SRC = "measure-src", LINE = "measure-line";
    const cleanup = () => { if (map.getLayer(LINE)) map.removeLayer(LINE); if (map.getSource(SRC)) map.removeSource(SRC); };
    cleanup();
    if (!measurePoints) return;
    const geojson: GeoJSON.Feature<GeoJSON.LineString> = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [measurePoints[0], measurePoints[1]] } };
    map.addSource(SRC, { type: "geojson", data: geojson });
    map.addLayer({ id: LINE, type: "line", source: SRC, paint: { "line-color": "#f59e0b", "line-width": 2, "line-dasharray": [4, 2] } });
    return cleanup;
  }, [measurePoints, mapLoaded]);



  // ── generated route layer (re-renders when route or stops change)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    for (const id of ["generated-route-glow", "generated-route-outline", "generated-route-line", "generated-stops-dot"]) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of ["generated-route", "generated-stops"]) {
      if (map.getSource(id)) map.removeSource(id);
    }

    if (!generatedRoute) return;

    const activeStops = generatedRoute.stops.filter((s) => !disabledStops.has(s.name));
    if (activeStops.length < 2) return;

    map.addSource("generated-route", {
      type: "geojson",
      data: {
        type: "Feature",
        properties: {},
        geometry: { type: "LineString", coordinates: activeStops.map((s) => s.coords) },
      } as GeoJSON.Feature<GeoJSON.LineString>,
    });

    map.addSource("generated-stops", {
      type: "geojson",
      data: {
        type: "FeatureCollection",
        features: generatedRoute.stops.map((s) => ({
          type: "Feature",
          properties: { stopId: s.id, name: s.name, disabled: disabledStops.has(s.name) },
          geometry: { type: "Point", coordinates: s.coords },
        })),
      } as GeoJSON.FeatureCollection<GeoJSON.Point>,
    });

    map.addLayer({
      id: "generated-route-glow",
      type: "line",
      source: "generated-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": generatedRoute.color,
        "line-width": 14,
        "line-opacity": 0.18,
        "line-blur": 8,
      },
    });

    map.addLayer({
      id: "generated-route-outline",
      type: "line",
      source: "generated-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
    });

    map.addLayer({
      id: "generated-route-line",
      type: "line",
      source: "generated-route",
      layout: { "line-join": "round", "line-cap": "round" },
      paint: {
        "line-color": generatedRoute.color,
        "line-width": 5,
        "line-dasharray": [3, 2],
        "line-opacity": 1,
      },
    });

    map.addLayer({
      id: "generated-stops-dot",
      type: "circle",
      source: "generated-stops",
      minzoom: 10,
      paint: {
        "circle-radius": 5,
        "circle-color": ["case", ["==", ["get", "disabled"], true], "#22c55e", "#ffffff"],
        "circle-stroke-color": [
          "case",
          ["==", ["get", "disabled"], true],
          "#9ca3af",
          generatedRoute.color,
        ],
        "circle-stroke-width": 2.5,
        "circle-opacity": ["case", ["==", ["get", "disabled"], true], 0.4, 1],
      },
    });

    map.on("click", "generated-route-line", () => setSelectedRouteId(null));

    map.on("click", "generated-stops-dot", (e) => {
      const props = e.features?.[0]?.properties as { stopId?: string; name?: string } | undefined;
      const name = props?.name;
      const stopId = props?.stopId;
      if (!name || !stopId) return;
      e.originalEvent.stopPropagation();
      setSelectedGeneratedStop((prev) => (prev === name ? null : name));
      setStationPopup({ stopId, name, routeId: generatedRoute.id, x: e.point.x, y: e.point.y, coords: [e.lngLat.lng, e.lngLat.lat] });
    });

    map.on("mouseenter", "generated-stops-dot", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "generated-stops-dot", () => { map.getCanvas().style.cursor = ""; });

    map.on("mouseenter", "generated-route-line", () => {
      map.getCanvas().style.cursor = "pointer";
      map.setPaintProperty("generated-route-line", "line-width", 8);
    });

    map.on("mouseleave", "generated-route-line", () => {
      map.getCanvas().style.cursor = "";
      map.setPaintProperty("generated-route-line", "line-width", 5);
    });
  }, [generatedRoute, disabledStops, mapLoaded]);

  // consume hoveredId to avoid lint warning
  useEffect(() => {
    void hoveredId;
  }, [hoveredId]);



  // ── Council preview: render animated multi-route layer ────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC_LINE = "council-preview-line";
    const SRC_DOTS = "council-preview-dots";
    const LYR_SHADOW = "council-preview-shadow";
    const LYR_LINE = "council-preview-lyr";
    const LYR_SHIMMER = "council-preview-shimmer";
    const LYR_DOTS = "council-preview-lyr-dots";

    if (shimmerRafRef.current !== null) {
      cancelAnimationFrame(shimmerRafRef.current);
      shimmerRafRef.current = null;
    }

    const validRoutes = (councilPreview ?? []).filter((r) => r.stops.length >= 2);
    if (validRoutes.length === 0) {
      for (const id of [LYR_SHADOW, LYR_SHIMMER, LYR_LINE, LYR_DOTS]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      for (const id of [SRC_LINE, SRC_DOTS]) {
        if (map.getSource(id)) map.removeSource(id);
      }
      return;
    }

    const lineGeoJSON: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: validRoutes.map((r) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: r.stops.map((s) => s.coords) },
        properties: { color: r.color },
      })),
    };
    const dotsGeoJSON: GeoJSON.FeatureCollection = {
      type: "FeatureCollection",
      features: validRoutes.flatMap((r) =>
        r.stops.map((s) => ({
          type: "Feature" as const,
          geometry: { type: "Point" as const, coordinates: s.coords },
          properties: { name: s.name, color: r.color },
        }))
      ),
    };

    if (map.getSource(SRC_LINE)) {
      (map.getSource(SRC_LINE) as mapboxgl.GeoJSONSource).setData(lineGeoJSON);
      (map.getSource(SRC_DOTS) as mapboxgl.GeoJSONSource).setData(dotsGeoJSON);
    } else {
      map.addSource(SRC_LINE, { type: "geojson", data: lineGeoJSON });
      map.addSource(SRC_DOTS, { type: "geojson", data: dotsGeoJSON });
      map.addLayer({ id: LYR_SHADOW, type: "line", source: SRC_LINE, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"] as unknown as string, "line-width": 14, "line-opacity": 0.12, "line-blur": 6 } });
      map.addLayer({ id: LYR_LINE, type: "line", source: SRC_LINE, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"] as unknown as string, "line-width": 5, "line-opacity": 0.75 } });
      map.addLayer({ id: LYR_SHIMMER, type: "line", source: SRC_LINE, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": 5, "line-opacity": 0, "line-dasharray": [3, 30] } });
      map.addLayer({ id: LYR_DOTS, type: "circle", source: SRC_DOTS, minzoom: 10, paint: { "circle-radius": 5, "circle-color": "#fff", "circle-stroke-color": ["get", "color"] as unknown as string, "circle-stroke-width": 2.5, "circle-opacity": 0.9 } });
    }

    const animMap = map;
    const PERIOD = 1800;
    const DASH = 3;
    const GAP = 30;
    const TOTAL = DASH + GAP;
    let start: number | null = null;
    function animate(ts: number) {
      if (!start) start = ts;
      const t = ((ts - start) % PERIOD) / PERIOD;
      const offset = t * TOTAL;
      const pre = offset % TOTAL;
      const pattern = pre < DASH
        ? [0, pre, DASH - pre, GAP]
        : [0, pre, DASH, GAP - (pre - DASH)];
      if (animMap.getLayer(LYR_SHIMMER)) {
        animMap.setPaintProperty(LYR_SHIMMER, "line-dasharray", pattern);
        animMap.setPaintProperty(LYR_SHIMMER, "line-opacity", 0.55 + 0.2 * Math.sin(t * Math.PI * 2));
      }
      shimmerRafRef.current = requestAnimationFrame(animate);
    }
    shimmerRafRef.current = requestAnimationFrame(animate);

    return () => {
      if (shimmerRafRef.current !== null) cancelAnimationFrame(shimmerRafRef.current);
    };
  }, [councilPreview, mapLoaded]);

  // ── tool-call map animations — callback ref (bypasses React batching) ─────
  useEffect(() => {
    // Keep the callback ref updated whenever map readiness changes
    onToolCallRef.current = (evt: ToolCallEvent) => {
      const map = mapRef.current;
      if (!map || !mapLoaded) return;
      const resultCount = Array.isArray(evt.result) ? evt.result.length : evt.result ? 1 : 0;
      trackEvent("Council Tool Call", {
        ...getAnalyticsContext(),
        tool_name: evt.tool,
        agent: evt.agent,
        call_status: evt.result === null ? "started" : "completed",
        result_count: resultCount,
      });
      const { call_id: id, tool, input, result } = evt;

      const SRC = "tool-anim-src";
      if (!map.getSource(SRC)) {
        map.addSource(SRC, { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({ id: "tool-search-pulse", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "search-center"], paint: { "circle-radius": 0, "circle-color": "transparent", "circle-stroke-color": "#ef4444", "circle-stroke-width": 2.5, "circle-stroke-opacity": 0.85 } });
        map.addLayer({ id: "tool-search-stops", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "search-stop"], paint: { "circle-radius": 5, "circle-color": "#ef4444", "circle-opacity": 0, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } });
        map.addLayer({ id: "tool-snap-line", type: "line", source: SRC, filter: ["==", ["get", "kind"], "snap-line"], paint: { "line-color": "#f59e0b", "line-width": 2, "line-opacity": 0.9, "line-dasharray": [4, 4] } });
        map.addLayer({ id: "tool-snap-from", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "snap-from"], paint: { "circle-radius": 6, "circle-color": "transparent", "circle-stroke-color": "#f59e0b", "circle-stroke-width": 2.5 } });
        map.addLayer({ id: "tool-snap-to", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "snap-to"], paint: { "circle-radius": 7, "circle-color": "#f59e0b", "circle-opacity": 0, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } });
        map.addLayer({ id: "tool-transfer-pulse", type: "circle", source: SRC, filter: ["==", ["get", "kind"], "transfer"], paint: { "circle-radius": 14, "circle-color": "transparent", "circle-stroke-color": "#0d9488", "circle-stroke-width": 2.5, "circle-stroke-opacity": 0 } });
      }

      const getFeats = () => toolAnimFeaturesRef.current;
      const setFeats = (f: GeoJSON.Feature[]) => {
        toolAnimFeaturesRef.current = f;
        (map.getSource(SRC) as mapboxgl.GeoJSONSource)?.setData({ type: "FeatureCollection", features: f });
      };
      const removeById = (cid: string) => setFeats(getFeats().filter(f => f.properties?.call_id !== cid));

      const existingRaf = toolAnimRafsRef.current.get(id);
      if (existingRaf !== undefined) cancelAnimationFrame(existingRaf);
      const existingTimeout = toolAnimTimeoutsRef.current.get(id);
      if (existingTimeout !== undefined) clearTimeout(existingTimeout);

      if (tool === "search_stops_near_point") {
        if (result === null) {
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), { type: "Feature", geometry: { type: "Point", coordinates: [input.lon, input.lat] }, properties: { kind: "search-center", call_id: id } }]);
          let start: number | null = null;
          const animate = (ts: number) => {
            if (!start) start = ts;
            const prog = Math.min((ts - start) / 700, 1);
            const ease = 1 - Math.pow(1 - prog, 3);
            if (map.getLayer("tool-search-pulse")) { map.setPaintProperty("tool-search-pulse", "circle-radius", ease * 55); map.setPaintProperty("tool-search-pulse", "circle-stroke-opacity", (1 - ease) * 0.85); }
            if (prog < 1) toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
          };
          toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
        } else {
          const stops = (result as { lon: number; lat: number; stop_name?: string }[] | null) ?? [];
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), ...stops.slice(0, 8).map(s => ({ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] }, properties: { kind: "search-stop", call_id: id } }))]);
          let start: number | null = null;
          const animate = (ts: number) => { if (!start) start = ts; const p = Math.min((ts - start) / 400, 1); if (map.getLayer("tool-search-stops")) map.setPaintProperty("tool-search-stops", "circle-opacity", p * 0.85); if (p < 1) toolAnimRafsRef.current.set(id, requestAnimationFrame(animate)); };
          toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
          toolAnimTimeoutsRef.current.set(id, setTimeout(() => { if (map.getLayer("tool-search-pulse")) map.setPaintProperty("tool-search-pulse", "circle-radius", 0); if (map.getLayer("tool-search-stops")) map.setPaintProperty("tool-search-stops", "circle-opacity", 0); removeById(id); }, 2500));
        }
      } else if (tool === "snap_to_nearest_stop") {
        if (result === null) {
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), { type: "Feature", geometry: { type: "Point", coordinates: [input.lon, input.lat] }, properties: { kind: "snap-from", call_id: id } }]);
        } else {
          const snap = result as { lon: number; lat: number } | null;
          if (!snap) { removeById(id); return; }
          setFeats([...getFeats().filter(f => f.properties?.call_id !== id), { type: "Feature", geometry: { type: "LineString", coordinates: [[input.lon, input.lat], [snap.lon, snap.lat]] }, properties: { kind: "snap-line", call_id: id } }, { type: "Feature", geometry: { type: "Point", coordinates: [input.lon, input.lat] }, properties: { kind: "snap-from", call_id: id } }, { type: "Feature", geometry: { type: "Point", coordinates: [snap.lon, snap.lat] }, properties: { kind: "snap-to", call_id: id } }]);
          let start: number | null = null;
          const animate = (ts: number) => { if (!start) start = ts; const t = ((ts - start) % 900) / 900; const offset = t * 8; const pre = offset % 8; const pattern = pre < 4 ? [0, pre, 4 - pre, 4] : [0, pre, 4, 4 - (pre - 4)]; if (map.getLayer("tool-snap-line")) map.setPaintProperty("tool-snap-line", "line-dasharray", pattern); if (map.getLayer("tool-snap-to")) map.setPaintProperty("tool-snap-to", "circle-opacity", 0.5 + 0.4 * Math.sin(t * Math.PI * 2)); toolAnimRafsRef.current.set(id, requestAnimationFrame(animate)); };
          toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
          toolAnimTimeoutsRef.current.set(id, setTimeout(() => { const raf = toolAnimRafsRef.current.get(id); if (raf !== undefined) { cancelAnimationFrame(raf); toolAnimRafsRef.current.delete(id); } if (map.getLayer("tool-snap-line")) { map.setPaintProperty("tool-snap-line", "line-opacity", 0); setTimeout(() => { if (map.getLayer("tool-snap-line")) map.setPaintProperty("tool-snap-line", "line-opacity", 0.9); }, 50); } if (map.getLayer("tool-snap-to")) map.setPaintProperty("tool-snap-to", "circle-opacity", 0); removeById(id); }, 1800));
        }
      } else if (tool === "check_transfer_at_location") {
        const stops = (result as { lon: number; lat: number }[] | null) ?? [];
        if (stops.length === 0) return;
        const feats: GeoJSON.Feature[] = stops.slice(0, 5).map((s, i) => ({ type: "Feature", geometry: { type: "Point", coordinates: [s.lon, s.lat] }, properties: { kind: "transfer", call_id: `${id}-${i}` } }));
        setFeats([...getFeats().filter(f => !(f.properties?.call_id as string)?.startsWith(id)), ...feats]);
        let start: number | null = null;
        const animate = (ts: number) => { if (!start) start = ts; const pulse = Math.abs(Math.sin(((ts - start) % 1000) / 1000 * Math.PI)); if (map.getLayer("tool-transfer-pulse")) { map.setPaintProperty("tool-transfer-pulse", "circle-radius", 8 + pulse * 14); map.setPaintProperty("tool-transfer-pulse", "circle-stroke-opacity", pulse * 0.85); } toolAnimRafsRef.current.set(id, requestAnimationFrame(animate)); };
        toolAnimRafsRef.current.set(id, requestAnimationFrame(animate));
        toolAnimTimeoutsRef.current.set(id, setTimeout(() => { const raf = toolAnimRafsRef.current.get(id); if (raf !== undefined) { cancelAnimationFrame(raf); toolAnimRafsRef.current.delete(id); } if (map.getLayer("tool-transfer-pulse")) map.setPaintProperty("tool-transfer-pulse", "circle-stroke-opacity", 0); setFeats(getFeats().filter(f => !(f.properties?.call_id as string)?.startsWith(id))); }, 2000));
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapLoaded]);

  // ── clean up tool animations when council closes ───────────────────────────
  useEffect(() => {
    if (!councilOpen) {
      toolAnimRafsRef.current.forEach((raf) => cancelAnimationFrame(raf));
      toolAnimRafsRef.current.clear();
      toolAnimTimeoutsRef.current.forEach((t) => clearTimeout(t));
      toolAnimTimeoutsRef.current.clear();
      toolAnimFeaturesRef.current = [];
      const map = mapRef.current;
      if (map) {
        for (const lyr of ["tool-search-pulse","tool-search-stops","tool-snap-line","tool-snap-from","tool-snap-to","tool-transfer-pulse"]) {
          if (map.getLayer(lyr)) map.removeLayer(lyr);
        }
        if (map.getSource("tool-anim-src")) map.removeSource("tool-anim-src");
      }
    }
  }, [councilOpen]);

  // ── add map layers for newly created custom lines
	  useEffect(() => {
	    const map = mapRef.current;
	    if (!map || !mapLoaded) return;
	    routes.forEach((route, routeIdx) => {
      if (map.getSource(`route-${route.id}`)) return; // already added
      map.addSource(`route-${route.id}`, { type: "geojson", lineMetrics: true, data: route.stops.length >= 2 ? routeToGeoJSON(route) : routeToGeoJSON(route) });
      map.addSource(`stops-${route.id}`, { type: "geojson", data: stopsToGeoJSON(route) });
	      const sc = route.type === "streetcar";
	      const bus = route.type === "bus";
	      map.addLayer({ id: `route-shadow-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": route.color, "line-width": bus ? 2 : sc ? 5 : 10, "line-opacity": bus ? 0.05 : sc ? 0.08 : 0.12, "line-blur": bus ? 2 : sc ? 3 : 4 } });
	      if (!bus && !sc) map.addLayer({ id: `route-outline-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": darkenColor(route.color), "line-width": 11, "line-opacity": 0.9, "line-trim-offset": [0, 1] } });
	      map.addLayer({ id: `route-line-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": route.color, "line-width": bus ? 1.5 : sc ? 3 : 7, "line-opacity": bus ? 0.7 : sc ? 0.85 : 1, "line-trim-offset": [0, 1] } });
      animateLineDraw(route.id, routeIdx * 50, bus, sc);
      map.addLayer({ id: `route-shimmer-${route.id}`, type: "line", source: `route-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": bus ? 1.5 : sc ? 3 : 7, "line-opacity": 0 } });
	      map.addLayer({ id: `stops-ring-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: sc ? 12 : 11, paint: { "circle-radius": bus ? 2 : sc ? 3.5 : 6, "circle-color": route.color, "circle-opacity": 0.25, "circle-stroke-width": 0 } });
	      map.addLayer({ id: `stops-selected-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: 9, filter: ["==", ["get", "name"], "__none__"], paint: { "circle-radius": bus ? 3.5 : sc ? 5 : 9, "circle-color": route.color, "circle-opacity": 0.5, "circle-stroke-width": bus ? 1 : sc ? 1.5 : 2, "circle-stroke-color": "#ffffff" } });
	      map.addLayer({ id: `stops-dot-${route.id}`, type: "circle", source: `stops-${route.id}`, minzoom: sc ? 12 : 11, paint: { "circle-radius": bus ? 1.5 : sc ? 2 : 3.5, "circle-color": "#ffffff", "circle-stroke-color": route.color, "circle-stroke-width": bus ? 1 : sc ? 1.5 : 2 } });
      // 📖 Learn: Mapbox "data expressions" let each feature drive layout properties using ["get", "prop"].
      // text-anchor "left" places the left edge of the text at the dot → text appears to the right.
      // text-anchor "top" places the top edge at the dot → text appears below.
      const yOff = bus ? 1 : sc ? 1.2 : 1.5;
      map.addLayer({ id: `stops-label-${route.id}`, type: "symbol", source: `stops-${route.id}`, minzoom: bus ? 14 : sc ? 12 : 11, layout: { "text-field": ["get", "name"] as unknown as string, "text-font": ["DIN Pro Medium", "Arial Unicode MS Regular"], "text-size": bus ? 8 : sc ? 9 : 11, "text-anchor": ["get", "labelAnchor"] as unknown as "top", "text-offset": ["case", ["==", ["get", "labelAnchor"], "left"], ["literal", [0.6, 0]], ["literal", [0, yOff]]] as unknown as [number, number], "text-optional": true, "visibility": "none" }, paint: { "text-color": route.color, "text-halo-color": darkMode ? "#111111" : "#ffffff", "text-halo-width": 1.5 } });
      // Correct label visibility immediately — the visibility effect runs before this effect
      // (earlier declaration order), so it can't set visibility on layers that don't exist yet.
      if (showStationLabels) map.setLayoutProperty(`stops-label-${route.id}`, "visibility", "visible");
      // Underground tunnel overlay
      map.addSource(`underground-${route.id}`, { type: "geojson", data: undergroundToGeoJSON(route) });
      map.addLayer({ id: `underground-line-${route.id}`, type: "line", source: `underground-${route.id}`, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#1e1e2e", "line-width": bus ? 1.5 : sc ? 3 : 7, "line-opacity": 0.55, "line-dasharray": [2, 2] } });
      // Portal markers
      map.addSource(`portals-${route.id}`, { type: "geojson", data: portalsToGeoJSON(route) });
      map.addLayer({ id: `portals-dot-${route.id}`, type: "circle", source: `portals-${route.id}`, paint: { "circle-radius": 5, "circle-color": "#1e1e2e", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5, "circle-opacity": 0.8 } });
	      map.on("click", `route-line-${route.id}`, () => { setSelectedRouteId(route.id); setSelectedStop(null); });
	      map.on("mouseenter", `route-line-${route.id}`, () => { map.getCanvas().style.cursor = "pointer"; map.setPaintProperty(`route-line-${route.id}`, "line-width", bus ? 3 : sc ? 5 : 10); });
	      map.on("mouseleave", `route-line-${route.id}`, () => { map.getCanvas().style.cursor = ""; map.setPaintProperty(`route-line-${route.id}`, "line-width", bus ? 1.5 : sc ? 3 : 7); });
	      map.on("click", `stops-dot-${route.id}`, (e) => {
	        if (didDragStopRef.current) { didDragStopRef.current = false; return; }
	        const props = e.features?.[0]?.properties as { stopId?: string; name?: string } | undefined;
	        const name = props?.name;
	        const stopId = props?.stopId;
        if (!name || !stopId) return;
        e.originalEvent.stopPropagation();
        if (drawModeRef.current === "select") {
          const key = `${name}::${route.id}`;
          const next = new Set(selectedStationsRef.current);
          if (next.has(key)) next.delete(key); else next.add(key);
          selectedStationsRef.current = next;
          setSelectedStations(new Set(next));
          return;
        }
        setStationPopup({ stopId, name, routeId: route.id, x: e.point.x, y: e.point.y, coords: [e.lngLat.lng, e.lngLat.lat] });
        setSelectedRouteId(route.id);
        setSelectedStop(stopId);
      });
      map.on("mouseenter", `stops-dot-${route.id}`, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", `stops-dot-${route.id}`, () => { map.getCanvas().style.cursor = ""; });
    });

    // ── Re-stack route layers relative to the basemap, AI overlay + each other ─
    // Mapbox draws layers in array order (no groups), so we rebuild the vertical
    // stack whenever the routes change. Target order, bottom→top:
    //
    //   basemap fills/roads + PLACE-NAME labels  (FINANCIAL DISTRICT, Toronto)
    //   → route lines              ← painted OVER the neighbourhood names
    //   → basemap street / transit labels + station pills  (kept legible on top)
    //   → route stop dots
    //   → route stop labels
    //   → AI annotation overlay    ← always the very top
    //
    // Constraints preserved:
    //   • crossing routes must not hide each other's dots → every line sits
    //     below every dot (we move lines first, dots after).
    //   • AI annotations the user asked for must never be covered → we anchor
    //     all moves at the AI overlay floor, not the literal top of the stack.
    const floor = aiOverlayFloor(map); // undefined → moveLayer lifts to very top

    // Basemap labels to keep ABOVE the route lines: streets, transit pills, POIs
    // — everything with text that ISN'T a place/admin name. Collected in their
    // existing bottom→top order so their relative stacking is preserved.
    const keepAboveLabelIds = (map.getStyle()?.layers ?? [])
      .filter((l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"] && !isPlaceNameLabel(l))
      .map((l) => l.id);

    const lineIds = routes.flatMap((r) => [`route-shadow-${r.id}`, `route-outline-${r.id}`, `route-line-${r.id}`, `route-shimmer-${r.id}`, `underground-line-${r.id}`]);
    const dotIds = routes.flatMap((r) => [`stops-ring-${r.id}`, `stops-selected-${r.id}`, `stops-dot-${r.id}`, `portals-dot-${r.id}`]);
    const labelIds = routes.map((r) => `stops-label-${r.id}`);

    // Each moveLayer(id, floor) drops `id` directly below the AI floor, ABOVE
    // whatever the previous call moved. Running the groups in this sequence
    // reproduces the target stack from the bottom up. Place-name labels are
    // deliberately NOT moved, so they stay below the lines.
    const moveBelowFloor = (id: string) => { if (map.getLayer(id)) map.moveLayer(id, floor); };
    lineIds.forEach(moveBelowFloor);           // 1. lines above the basemap
    keepAboveLabelIds.forEach(moveBelowFloor); // 2. street/transit labels above lines
    dotIds.forEach(moveBelowFloor);            // 3. stop dots above those
    labelIds.forEach(moveBelowFloor);          // 4. stop labels on top of our stack
  }, [routes, mapLoaded]);

  // ── drag-to-reposition stops while in edit mode
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !addStationToLine) return;

    const lineId = addStationToLine;
    const layerId = `stops-dot-${lineId}`;
    if (!map.getLayer(layerId)) return;

    let dragging: { stopId: string; coords: [number, number] } | null = null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onMouseDown = (e: mapboxgl.MapMouseEvent & { features?: any[] }) => {
      const stopId = e.features?.[0]?.properties?.stopId as string | undefined;
      if (!stopId) return;
      // Allow dragging any stop (all routes are now editable)
      const route = routesRef.current.find((r) => r.id === lineId);
      if (!route) return;
      e.preventDefault();
      dragging = { stopId, coords: [e.lngLat.lng, e.lngLat.lat] };
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grabbing";
    };

    const onMouseMove = (e: mapboxgl.MapMouseEvent) => {
      if (!dragging) return;
      const newCoords: [number, number] = [e.lngLat.lng, e.lngLat.lat];
      dragging.coords = newCoords;
      // Update map sources directly — no React re-render for smooth dragging
      const route = routesRef.current.find((r) => r.id === lineId);
      if (!route) return;
      const allStops = route.stops.map((s) => s.id === dragging!.stopId ? { ...s, coords: newCoords } : s);
      const stopSrc = map.getSource(`stops-${lineId}`) as mapboxgl.GeoJSONSource | undefined;
      if (stopSrc) stopSrc.setData(stopsToGeoJSON({ ...route, stops: allStops }));
      const lineSrc = map.getSource(`route-${lineId}`) as mapboxgl.GeoJSONSource | undefined;
      if (lineSrc && allStops.length >= 2) lineSrc.setData(routeToGeoJSON({ ...route, stops: allStops, shape: undefined }));
      map.getCanvas().style.cursor = "grabbing";
    };

    const onMouseUp = () => {
      if (!dragging) return;
      const { stopId, coords } = dragging;
      const route = routesRef.current.find((r) => r.id === lineId);
      const stopName = route?.stops.find((s) => s.id === stopId)?.name;
      dragging = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
      didDragStopRef.current = true;
      snapshotHistory();
      setRoutes((prev) =>
        prev.map((r) => r.id === lineId ? { ...r, shape: undefined, stops: r.stops.map((s) => s.id === stopId ? { ...s, coords } : s) } : r)
      );
      trackEvent("Station Moved", {
        ...getAnalyticsContext(),
        route_id: lineId,
        route_name: route?.name,
        route_type: route?.type,
        stop_name: stopName,
        lng: Number(coords[0].toFixed(5)),
        lat: Number(coords[1].toFixed(5)),
      });
    };

    const onEnter = () => { if (!dragging) map.getCanvas().style.cursor = "grab"; };
    const onLeave = () => { if (!dragging) map.getCanvas().style.cursor = ""; };

    map.on("mousedown", layerId, onMouseDown);
    map.on("mousemove", onMouseMove);
    map.on("mouseup", onMouseUp);
    map.on("mouseenter", layerId, onEnter);
    map.on("mouseleave", layerId, onLeave);

    return () => {
      map.off("mousedown", layerId, onMouseDown);
      map.off("mousemove", onMouseMove);
      map.off("mouseup", onMouseUp);
      map.off("mouseenter", layerId, onEnter);
      map.off("mouseleave", layerId, onLeave);
      map.dragPan.enable();
    };
  }, [addStationToLine, mapLoaded]);

  if (!TOKEN) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-stone-100">
        <p className="text-center">
          <span className="block text-base font-semibold text-red-500">Mapbox token missing</span>
          <span className="mt-1 block text-sm text-stone-500">
            Set{" "}
            <code className="rounded bg-stone-200 px-1 text-stone-700">
              NEXT_PUBLIC_MAPBOX_TOKEN
            </code>{" "}
            in <code className="rounded bg-stone-200 px-1 text-stone-700">.env</code>
          </span>
        </p>
      </div>
    );
  }

  const showGeneratedPanel = !!generatedRoute && !selectedRoute;
  const hasSelection = hasBoundary || selectedNeighbourhoods.size > 0 || selectedStations.size > 0;

  function handleExport() {
    void (async () => {
      trackEvent("GTFS Export Started", getAnalyticsContext(routes));
      setExportProgress(0);
      try {
        const JSZip = (await import("jszip")).default;
        const { generateGTFS } = await import("~/lib/gtfs");
        const { validateGTFS } = await import("~/lib/gtfs-validate");
        const files = generateGTFS(routes);
        const result = validateGTFS(files);
        const zip = new JSZip();
        for (const [name, content] of Object.entries(files)) {
          zip.file(name, content);
        }
        const blob = await zip.generateAsync(
          { type: "blob", compression: "DEFLATE" },
          ({ percent }) => setExportProgress(Math.round(percent)),
        );
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "transit-plan-gtfs.zip";
        a.click();
        URL.revokeObjectURL(url);
        setValidationResult({ result, context: "export" });
        trackEvent("GTFS Export Completed", {
          ...getAnalyticsContext(routes),
          valid: result.valid,
          exported_routes: result.stats.routes,
          exported_stops: result.stats.stops,
          exported_trips: result.stats.trips,
        });
      } catch (error) {
        trackEvent("GTFS Export Failed", {
          ...getAnalyticsContext(routes),
          error: error instanceof Error ? error.message : "unknown",
        });
      } finally {
        setExportProgress(null);
      }
    })();
  }

  function handleImport() {
    trackEvent("GTFS Import Picker Opened", getAnalyticsContext());
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.json,application/zip,application/json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      setPendingImportFile(file);
    };
    input.click();
  }

  function removeCustomLineFromMap(routeId: string) {
    const map = mapRef.current;
    if (!map) return;
    [`route-shadow-${routeId}`, `route-outline-${routeId}`, `route-line-${routeId}`, `stops-ring-${routeId}`, `stops-selected-${routeId}`, `stops-dot-${routeId}`, `stops-label-${routeId}`, `underground-line-${routeId}`, `portals-dot-${routeId}`].forEach((id) => {
      if (map.getLayer(id)) map.removeLayer(id);
    });
    [`route-${routeId}`, `stops-${routeId}`, `underground-${routeId}`, `portals-${routeId}`].forEach((id) => {
      if (map.getSource(id)) map.removeSource(id);
    });
  }

  function confirmImport(file: File, merge: boolean) {
    setPendingImportFile(null);
    trackEvent("GTFS Import Started", {
      ...getAnalyticsContext(),
      file_name: file.name,
      merge,
    });

    if (!merge) {
      // Replace: remove all existing custom line layers/sources from the map before replacing state
      for (const route of routes) removeCustomLineFromMap(route.id);
    }

    const applyRoutes = (rawIncoming: Route[]) => {
      // GTFS/JSON files carry no stop ids of ours — mint them before anything
      // downstream tries to address an imported stop.
      const incoming = withStopIds(rawIncoming);
      const incomingIds = new Set(incoming.map((r) => r.id));
      const nextRoutes = merge
        ? [...routes.filter((r) => !incomingIds.has(r.id)), ...incoming]
        : incoming;

      trackEvent("GTFS Import Completed", {
        ...getAnalyticsContext(nextRoutes),
        file_name: file.name,
        merge,
        imported_routes: incoming.length,
        imported_stations: incoming.reduce((sum, route) => sum + route.stops.length, 0),
      });

      if (merge) {
        setRoutes((prev) => {
          // Imported routes win on ID conflict; remove stale map layers for replaced IDs
          for (const r of prev) {
            if (incomingIds.has(r.id)) removeCustomLineFromMap(r.id);
          }
          const kept = prev.filter((r) => !incomingIds.has(r.id));
          return [...kept, ...incoming];
        });
      } else {
        setRoutes(incoming);
      }
    };

    if (file.name.endsWith(".zip")) {
      void (async () => {
        try {
          const JSZip = (await import("jszip")).default;
          const { importGTFS } = await import("~/lib/gtfs-import");
          const { validateGTFS } = await import("~/lib/gtfs-validate");
          const zip = await JSZip.loadAsync(file).catch(() => {
            throw new Error("Could not read ZIP file. Make sure the file is a valid .zip archive.");
          });

          // Extract raw file strings for validation
          const gtfsFileNames = [
            "agency.txt", "routes.txt", "trips.txt", "stop_times.txt",
            "stops.txt", "shapes.txt", "calendar.txt", "calendar_dates.txt",
          ];
          const gtfsFiles: Record<string, string> = {};
          for (const name of gtfsFileNames) {
            const entry = zip.file(name);
            if (entry) gtfsFiles[name] = await entry.async("string");
          }
          const validation = validateGTFS(gtfsFiles);

          if (!validation.valid) {
            // Block import, show validation errors
            setValidationResult({ result: validation, context: "import" });
            return;
          }

          const importedRoutes = await importGTFS(zip);
          applyRoutes(importedRoutes);

          // Show warnings (if any) after successful import
          if (validation.issues.length > 0) {
            setValidationResult({ result: validation, context: "import" });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown error while importing GTFS.";
          trackEvent("GTFS Import Failed", {
            ...getAnalyticsContext(),
            file_name: file.name,
            merge,
            error: msg,
          });
          setImportError(msg);
        }
      })();
    } else {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target?.result as string) as {
            customLines?: Route[];
            routes?: Route[];
          };
          applyRoutes(parsed.routes ?? parsed.customLines ?? []);
        } catch {
          trackEvent("GTFS Import Failed", {
            ...getAnalyticsContext(),
            file_name: file.name,
            merge,
            error: "json_parse_failed",
          });
          setImportError("Could not parse the JSON file. Make sure it was exported from this app.");
        }
      };
      reader.readAsText(file);
    }
  }

  return (
    <div className="relative h-full w-full">
	      <div ref={containerRef} className="h-full w-full" />

	      <div className="hidden md:flex absolute top-6 left-6 flex-col pointer-events-auto" style={{ maxHeight: "calc(100vh - 48px)" }}>
	        <LinesPanel
	          routes={routes}
	          hiddenRoutes={hiddenRoutes}
	          generatedRoute={generatedRoute}
	          collapsedSections={collapsedSections}
	          addStationToLine={addStationToLine}
	          experimentalFeatures={experimentalFeatures}
	          linesHeight={linesHeight}
	          onSetHiddenRoutes={setHiddenRoutes}
	          onSetCollapsedSections={setCollapsedSections}
	          onSetAddStationToLine={setAddStationToLine}
	          onActivateRoute={(routeId) => {
	            const busRoute = BUS_ROUTES.find((r) => r.id === routeId);
	            // BUS_ROUTES stops are already id'd in transit-data; withStopIds is
	            // a cheap no-op guard so activation can never introduce an id-less stop.
	            if (busRoute) setRoutes((prev) => [...prev, ...withStopIds([busRoute])]);
	          }}
	          onSetDrawMode={handleSetDrawMode}
	          onSnapshotHistory={snapshotHistory}
	          onNewLine={() => setShowNewLineModal(true)}
	          onSelectGeneratedRoute={() => setSelectedRouteId(null)}
	        />

        {experimentalFeatures && (
          <div
            className="h-2.5 flex items-center justify-center group shrink-0 cursor-row-resize"
            onMouseDown={(e) => {
              e.preventDefault();
              const startY = e.clientY;
              const startH = linesHeightRef.current;
              const containerH = window.innerHeight - 60;
              const onMove = (ev: MouseEvent) => {
                const next = Math.max(80, Math.min(containerH - 80, startH + ev.clientY - startY));
                linesHeightRef.current = next;
                setLinesHeight(next);
              };
              const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
              };
              document.addEventListener("mousemove", onMove);
              document.addEventListener("mouseup", onUp);
            }}
          >
            <div className="h-1 w-8 rounded-full bg-stone-200 group-hover:bg-stone-400 transition-colors" />
          </div>
        )}

        {experimentalFeatures && (
          <ExperimentalPanel
            routes={routes}
            hiddenRoutes={hiddenRoutes}
            selectedRoute={selectedRoute}
            stationPopulations={stationPopulations}
            onZoomToCity={(lat, lng, zoom) => mapRef.current?.flyTo({ center: [lng, lat], zoom: zoom ?? 11, duration: 1200 })}
            style={{ maxHeight: `calc(100vh - 48px - ${linesHeight}px - 10px)` }}
            isochroneOrigin={isochroneOrigin}
            onSetIsochroneOrigin={setIsochroneOrigin}
            isochroneMinutes={isochroneMinutes}
            onSetIsochroneMinutes={setIsochroneMinutes}
            showCatchment={showCatchment}
            onToggleCatchment={setShowCatchment}
            catchmentRadius={catchmentRadius}
            onSetCatchmentRadius={setCatchmentRadius}
            showDisruption={showDisruption}
            onToggleDisruption={setShowDisruption}
            disruptionRadius={disruptionRadius}
            onSetDisruptionRadius={setDisruptionRadius}
            disruptionRouteId={disruptionRouteId}
            onSetDisruptionRouteId={setDisruptionRouteId}
            measureMode={measureMode}
            onToggleMeasureMode={setMeasureMode}
            measureDistanceKm={measureDistanceKm}
            imperial={imperial}
            pickingIsochroneOrigin={pickingIsochroneOrigin}
            onStartPickIsochroneOrigin={() => setPickingIsochroneOrigin(true)}
            onExportMapPng={exportMapPng}
            onExportMapPdf={exportMapPdf}
            onExportSchematic={exportSchematicSvg}
            onCopyShareLink={copyShareLink}
            shareLinkCopied={shareLinkCopied}
            isoMode={isoMode}
            onSetIsoMode={setIsoMode}
            onSimUpdate={(hour, activeIds) => setSimState(hour !== null ? { hour, activeIds } : null)}
            onOpenGameMode={() => setShowGameMode(true)}
          />
        )}

      </div>

        {focusedNeighbourhood && (
          <div className="absolute bottom-6 left-6 pointer-events-auto z-20">
            <NeighbourhoodPanel
              name={focusedNeighbourhood.name}
              lat={focusedNeighbourhood.lat}
              lng={focusedNeighbourhood.lng}
              geometry={focusedNeighbourhood.geometry}
              popRawData={popRawData}
              trafficFeatures={trafficGeoJSON?.features ?? []}
              onClose={() => setFocusedNeighbourhood(null)}
            />
          </div>
        )}

      {showGameMode && <GameMode routes={routes} onClose={() => setShowGameMode(false)} />}
      {showChangelog && <ChangelogModal onClose={() => setShowChangelog(false)} />}
      {showFeedback && <FeedbackModal onClose={() => setShowFeedback(false)} />}

      {/* Reset confirmation */}
      {showResetConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-6 w-full max-w-sm rounded-2xl border border-[#D7D7D7] bg-white p-7 shadow-2xl">
            <div className="mb-1 flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-red-600" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-9" />
                </svg>
              </div>
              <p className="text-sm font-semibold text-stone-800">Reset project?</p>
            </div>
            <p className="mb-1 pl-10.5 text-sm text-stone-500">
              This removes all custom lines and restores the default network. <span className="font-medium text-stone-700">This cannot be undone.</span>
            </p>
            <p className="mb-5 pl-10.5 text-sm text-amber-600">
              We recommend exporting your work first.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowResetConfirm(false)}
                className="rounded-xl border border-[#D7D7D7] px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { handleExport(); setShowResetConfirm(false); }}
                className="rounded-xl border border-[#D7D7D7] px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
              >
                Export first
              </button>
              <button
                onClick={() => {
                  // Clean up GO layers if currently shown
                  if (showGoTrain) {
                    const map = mapRef.current;
                    if (map) GO_TRAIN_ROUTES.forEach((r) => {
                      [`route-shadow-${r.id}`, `route-outline-${r.id}`, `route-line-${r.id}`, `route-shimmer-${r.id}`, `stops-ring-${r.id}`, `stops-selected-${r.id}`, `stops-dot-${r.id}`, `stops-label-${r.id}`, `underground-line-${r.id}`, `portals-dot-${r.id}`].forEach((id) => { if (map.getLayer(id)) map.removeLayer(id); });
                      [`route-${r.id}`, `stops-${r.id}`, `underground-${r.id}`, `portals-${r.id}`].forEach((id) => { if (map.getSource(id)) map.removeSource(id); });
                    });
                    setShowGoTrain(false);
                  }
                  setRoutes([
                    ...ROUTES.filter((r) => r.type === "streetcar"),
                    ...ROUTES.filter((r) => r.type !== "bus" && r.type !== "streetcar"),
                  ]);
                  setShowResetConfirm(false);
                }}
                className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 transition-colors"
              >
                Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add-station notification — below top-center toolbar */}
      {addStationToLine && (
        <div className="pointer-events-none absolute top-[85px] left-0 right-0 flex justify-center">
          <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl border border-indigo-200 dark:border-indigo-700 bg-indigo-100 shadow-sm">
            <div className="flex items-center gap-3 px-4 py-2.5 text-sm text-indigo-700 dark:text-indigo-200">
              <span>{snapProgress?.routeId === addStationToLine ? "Placing…" : "Click map to add station"}</span>
              <span className="h-4 w-px bg-indigo-200 dark:bg-indigo-700" />
              <button
                onClick={() => setAddStationToLine(null)}
                className="font-semibold hover:text-indigo-900 dark:hover:text-indigo-100 transition-colors"
              >
                Done
              </button>
            </div>
            {snapProgress?.routeId === addStationToLine && (
              <div className="h-0.5 bg-indigo-100 dark:bg-indigo-800">
                <div
                  className="h-full bg-indigo-400 dark:bg-indigo-400 transition-[width] duration-500 ease-out"
                  style={{ width: `${snapProgress.pct}%` }}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add-portal notification — below top-center toolbar */}
      {addPortalToLine && (
        <div className="pointer-events-none absolute top-[85px] left-0 right-0 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-stone-300 bg-stone-800 px-4 py-2.5 text-sm text-white shadow-sm">
            <span>Click route to place portal marker</span>
            <span className="h-4 w-px bg-stone-600" />
            <button
              onClick={() => setAddPortalToLine(null)}
              className="font-semibold hover:text-stone-300 transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* Top-center toolbar (desktop only) */}
      <div className="pointer-events-none hidden md:flex absolute top-5 left-0 right-0 justify-center gap-2">
        {/* Layers dropdown — ALL map overlays live here. Pinned ones hang as a vertical quick-toggle stack below the button. */}
        <LayersDropdown
          overlays={(
            [
              { id: "heatmap", label: "Population Density", sub: "Residents per km²", on: showHeatmap, loading: popLoading, color: "#ef4444", onToggle: () => setShowHeatmap((v) => !v) },
              { id: "traffic", label: "Traffic", sub: "Current Mapbox traffic", on: showTraffic, loading: trafficLoading, color: "#f59e0b", onToggle: () => setShowTraffic((v) => !v) },
              { id: "canadaPop", label: "Canada pop density", sub: "Country-wide population heatmap", on: showCanadaPop, loading: canadaPopLoading, color: "#fbbf24", onToggle: async () => {
                if (canadaPopLoading) return;
                const newValue = !showCanadaPop;
                setShowCanadaPop(newValue);
                if (newValue) {
                  setCanadaPopLoading(true);
                  // 📖 Learn: the dataset is loaded lazily, so we show a spinner
                  // for a beat after toggling on. 1 s is an empirical wait —
                  // matches the original implementation in the gear menu.
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  setCanadaPopLoading(false);
                }
              } },
              { id: "stationLabels", label: "Station labels", sub: "Show stop names on each line", on: showStationLabels, color: "#78716c", onToggle: () => setShowStationLabels((v) => !v) },
              { id: "coverage", label: "Coverage Zones", sub: "500 m radius per stop", on: showCoverageZones, color: "#0ea5e9", onToggle: () => setShowCoverageZones((v) => !v) },
              { id: "serviceHeatmap", label: "Service Heatmap", sub: "Density weighted by mode", on: showServiceHeatmap, color: "#f97316", onToggle: () => setShowServiceHeatmap((v) => !v) },
              { id: "liveVehicles", label: "Live vehicles", sub: "Real-time TTC positions", on: showLiveVehicles, color: "#10b981", onToggle: () => setShowLiveVehicles((v) => !v) },
              { id: "transitDesert", label: "Transit deserts", sub: "Underserved population areas", on: showTransitDesert, loading: desertComputing, color: "#f43f5e", onToggle: () => setShowTransitDesert((v) => !v) },
              { id: "catchment", label: "Catchment circles", sub: "Radius around each station (advanced config in Analysis panel)", on: showCatchment, color: "#10b981", onToggle: () => setShowCatchment((v) => !v) },
              { id: "disruption", label: "Disruption zones", sub: "Noise/impact buffer (advanced config in Analysis panel)", on: showDisruption, color: "#f43f5e", onToggle: () => setShowDisruption((v) => !v) },
              {
                id: "isochrone",
                label: "Isochrone (travel time)",
                sub: isochroneOrigin ? `${isochroneMinutes} min ${isoMode}` : "Pick origin to start",
                on: !!isochroneOrigin,
                color: "#6366f1",
                // 📖 Learn: noPin on Isochrone — its config UI lives inline,
                // so pinning it as a toolbar pill would lose the configurator.
                noPin: true,
                onToggle: () => {
                  // Toggle off only — toggling on without an origin is meaningless;
                  // user must use the inline picker to set one.
                  if (isochroneOrigin) setIsochroneOrigin(null);
                  else setPickingIsochroneOrigin(true);
                },
                details: (
                  <IsochroneDetails
                    routes={routes}
                    isochroneOrigin={isochroneOrigin}
                    onSetIsochroneOrigin={setIsochroneOrigin}
                    isochroneMinutes={isochroneMinutes}
                    onSetIsochroneMinutes={setIsochroneMinutes}
                    isoMode={isoMode}
                    onSetIsoMode={setIsoMode}
                    pickingIsochroneOrigin={pickingIsochroneOrigin}
                    onStartPickIsochroneOrigin={() => setPickingIsochroneOrigin(true)}
                  />
                ),
              },
              {
                id: "aiFindings",
                label: "AI findings",
                sub: aiAnnotations.length > 0
                  ? `${aiAnnotations.length} annotation${aiAnnotations.length === 1 ? "" : "s"} from chat`
                  : "Ask AI to draw on the map",
                on: aiAnnotationsVisible && aiAnnotations.length > 0,
                color: "#14b8a6",
                onToggle: () => setAiAnnotationsVisible(!aiAnnotationsVisible),
              },
            ] satisfies OverlaySpec[]
          ).map((o) => ({ ...o, icon: OVERLAY_ICONS[o.id] }))}
          pinned={pinnedLayers}
          onTogglePin={(id) => setPinnedLayers((prev) => {
            // 📖 Learn: build a new Set so React detects the state change.
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          })}
          actions={(
            [
              {
                id: "measure",
                label: measureMode
                  ? (measureDistanceKm != null ? `Measuring · ${measureDistanceKm.toFixed(2)} km` : "Click two points on map…")
                  : "Measure distance",
                active: measureMode,
                onClick: () => setMeasureMode((v) => !v),
                icon: (
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M2 11l3-3 3 3 3-3 3 3M2 13.5h12" />
                  </svg>
                ),
              },
              {
                id: "customOverlay",
                label: customOverlay ? "Custom overlay loaded" : "Load custom overlay…",
                badge: customOverlay
                  ? (customOverlayName.length > 22 ? customOverlayName.slice(0, 21) + "…" : customOverlayName)
                  : undefined,
                active: !!customOverlay,
                onClick: () => (customOverlay ? clearOverlay() : handleOverlayImport()),
                icon: customOverlay ? (
                  // X icon when loaded — clicking clears
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="h-3.5 w-3.5 text-orange-400">
                    <path d="M2 2l12 12M14 2L2 14" />
                  </svg>
                ) : (
                  // Upload arrow when empty
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-3.5 w-3.5">
                    <path d="M8 2v8M5 7l3 3 3-3" />
                    <rect x="2" y="11" width="12" height="3" rx="1" fill="none" />
                  </svg>
                ),
              },
            ] satisfies ActionRow[]
          )}
        />

        {/* Simulate button */}
        <button
          onClick={() => { setShowSimPanel((v) => !v); setShowPlansPanel(false); }}
          className={`pointer-events-auto flex h-13 items-center gap-3 rounded-xl border border-[#D7D7D7] bg-white px-6 text-base font-normal shadow-sm transition-all ${
            showSimPanel ? "text-indigo-700 border-stone-400" : "text-stone-400"
          }`}
        >
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ background: showSimPanel ? "#6366f1" : "#d1d5db" }}
          />
          Simulate
        </button>

        {/* Plans button */}
        <button
          onClick={() => { setShowPlansPanel((v) => !v); setShowSimPanel(false); }}
          className={`pointer-events-auto flex h-13 items-center gap-2.5 rounded-xl border bg-white px-5 text-base font-normal shadow-sm transition-all ${
            showPlansPanel ? "border-stone-400 text-indigo-700" : "border-[#D7D7D7] text-stone-400"
          }`}
        >
          <span
            className="h-3 w-3 shrink-0 rounded-full transition-colors"
            style={{ background: showPlansPanel ? "#6366f1" : currentPlanId ? (planIsDirty ? "#f59e0b" : "#6366f1") : "#d1d5db" }}
          />
          Plans
        </button>

        {/* Ask AI button — opens free-form chat without requiring map selection.
            For the Council deliberation workflow, users still select neighbourhoods
            on the map and click "Generate Route". This is the conversational entry point.
            Hidden unless opted in via Settings → "Ask AI". */}
        {showAskAIButton && (
        <button
          onClick={() => setShowAIChat((v) => !v)}
          className={`pointer-events-auto flex h-13 items-center gap-2.5 rounded-xl border bg-white px-5 text-base font-normal shadow-sm transition-all ${
            showAIChat ? "border-stone-400 text-teal-700" : "border-[#D7D7D7] text-stone-400"
          }`}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4 shrink-0">
            <path d="M8 1.5L9.5 6L14 7.5L9.5 9L8 13.5L6.5 9L2 7.5L6.5 6Z" />
          </svg>
          Ask AI
          <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold text-violet-600 uppercase tracking-wide">beta</span>
        </button>
        )}

        {/* Draw toolbar — wrapped in relative so the badge can anchor to it */}
        <div className="relative">
        <div className="pointer-events-auto flex h-13 items-center gap-1 rounded-xl border border-[#D7D7D7] bg-white px-2 shadow-sm">
          {/* Normal (default/view — no active tool) */}
          <div className="group relative">
            <button
              onClick={() => handleSetDrawMode("normal")}
              aria-label="Explore mode"
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                drawMode === "normal" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              {/* Arrow cursor */}
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4.5 w-4.5">
                <path d="M4 1.5 L4 17 L8 13 L11 19 L13 18 L10 12 L16 12 Z" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Explore mode
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>

          <div className="mx-1 h-6 w-px bg-stone-200" />

          {/* Select neighbourhoods */}
          <div className="group relative">
            <button
              onClick={() => handleSetDrawMode("select")}
              aria-label="Select neighbourhoods"
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                drawMode === "select" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              {/* Cursor + dashed selection box — indicates click-to-select-region */}
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4.5 w-4.5">
                <path d="M2.5 1.5 L2.5 12.5 L5.5 9.5 L7.5 14 L9 13.3 L7 8.8 L11 8.8 Z" />
                <rect x="11.5" y="11" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.2" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Select neighbourhoods
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>

          {/* Polygon boundary (temporarily hidden) */}
          {/*
          <div className="mx-1 h-6 w-px bg-stone-200" />


           <div className="group relative">
            <button
              onClick={() => handleSetDrawMode("boundary")}
              className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
                drawMode === "boundary" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" className="h-4 w-4">
                <polygon points="10,2 17,6.5 14.5,16 5.5,16 3,6.5" strokeWidth="1.6" strokeLinejoin="round" strokeDasharray="2.5 1.5" />
                <circle cx="10" cy="2" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="17" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="14.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="5.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="3" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Draw boundary
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div> */}

          {/* Undo / Redo */}
          <div className="mx-1 h-6 w-px bg-stone-200" />
          <div className="group relative">
            <button
              onClick={handleUndo}
              disabled={!canUndo}
              aria-label="Undo"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-stone-50 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M3 9a6 6 0 1 1 1.5 4" />
                <polyline points="3 4 3 9 8 9" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Undo <span className="opacity-60">⌘Z</span>
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>
          <div className="group relative">
            <button
              onClick={handleRedo}
              disabled={!canRedo}
              aria-label="Redo"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-stone-50 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                <path d="M17 9a6 6 0 1 0-1.5 4" />
                <polyline points="17 4 17 9 12 9" />
              </svg>
            </button>
            <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
              Redo <span className="opacity-60">⌘⇧Z</span>
              <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
            </div>
          </div>

          {/* Clear button — visible when there's a drawn boundary or selected neighbourhoods */}
          {hasSelection && (
            <>
              <div className="mx-1 h-6 w-px bg-stone-200" />
              <div className="group relative">
                <button
                  onClick={handleClearAll}
                  aria-label="Clear selection"
                  className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-red-50 hover:text-red-500"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                    <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193v-.443A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                  </svg>
                </button>
                <div className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-stone-800 px-2 py-1 text-xs whitespace-nowrap text-white opacity-0 transition-opacity group-hover:opacity-100">
                  Clear selection
                  <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-stone-800" />
                </div>
              </div>
            </>
          )}
        </div>

        {/* Drawing hint — shown while actively drawing a polygon */}
        {drawMode === "boundary" && (
          <div className="pointer-events-auto absolute top-0 left-full ml-2 flex h-13 items-center gap-3 whitespace-nowrap rounded-xl border border-stone-200 bg-white px-4 text-sm text-stone-500 shadow-sm">
            <span>Double-click to finish</span>
            <span className="h-4 w-px bg-stone-200" />
            <button
              onClick={() => handleSetDrawMode("normal")}
              className="font-medium text-stone-700 hover:text-red-500 transition-colors"
            >
              Cancel
            </button>
          </div>
        )}

        </div>
      </div>

      {simState && (
        <div className="pointer-events-none absolute top-[85px] left-0 right-0 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2.5 rounded-xl border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-700 shadow-sm animate-pulse">
            <span className="h-2 w-2 rounded-full bg-indigo-500" />
            <span className="font-semibold">{`${simState.hour === 0 ? "12" : simState.hour > 12 ? simState.hour - 12 : simState.hour}:00 ${simState.hour < 12 ? "AM" : "PM"}`}</span>
            <span className="text-indigo-400 text-xs">{simState.activeIds.length} routes active</span>
          </div>
        </div>
      )}

      {/* Show in Select mode (even before the first click, as a discoverable
          hint) or whenever there's any selection. */}
      {(drawMode === "select" || selectedNeighbourhoods.size > 0 || selectedStations.size > 0) && !addStationToLine && (
        <div className="pointer-events-none absolute top-[85px] left-0 right-0 flex justify-center">
          {/* Claude Code-style selection chip: subtle outline, region glyph,
              bold count, and an inline clear button. */}
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-stone-200 bg-white/95 dark:border-stone-700 dark:bg-stone-900/95 backdrop-blur-sm py-1.5 pl-2.5 pr-1.5 text-[13px] text-stone-500 dark:text-stone-400 shadow-sm">
            {/* stacked-region glyph */}
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" className="h-3.5 w-3.5 shrink-0 text-stone-400">
              <path d="M8 1.8 14 5 8 8.2 2 5 8 1.8Z" />
              <path d="M2.4 8 8 10.9 13.6 8" />
              <path d="M2.4 11 8 13.9 13.6 11" />
            </svg>
            {selectedNeighbourhoods.size === 0 && selectedStations.size === 0 ? (
              // In Select mode but nothing picked yet — guide the user.
              <span className="pr-1">Click areas on the map to select</span>
            ) : (
              <>
                <span>
                  <span className="font-medium text-stone-700 dark:text-stone-200">{selectedNeighbourhoods.size}</span>
                  {" "}neighbourhood{selectedNeighbourhoods.size !== 1 ? "s" : ""}
                  {selectedStations.size > 0 && (
                    <>
                      , <span className="font-medium text-stone-700 dark:text-stone-200">{selectedStations.size}</span>
                      {" "}station{selectedStations.size !== 1 ? "s" : ""}
                    </>
                  )}
                  {" "}selected
                </span>
                <button
                  onClick={handleClearAll}
                  aria-label="Clear selection"
                  className="ml-0.5 flex h-5 w-5 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-700 dark:hover:text-stone-200"
                >
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" className="h-3 w-3">
                    <path d="M3 3l6 6M9 3l-6 6" />
                  </svg>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Simulation panel — slides in from the right, independent of route panel */}
      <div
        className={`pointer-events-none absolute right-6 bottom-6 flex items-start transition-all duration-300 ease-in-out z-10 ${
          showSimPanel && !selectedRoute && !showGeneratedPanel ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
        style={{ top: "80px" }}
      >
        <SimulationPanel
          customRoutes={routes.filter((r) => r.id.startsWith("custom-"))}
          onClose={() => { setShowSimPanel(false); setSimResults(null); setAnimAgents(null); }}
          onResults={(r) => { setSimResults(r); setAnimAgents(null); }}
          onAnimate={(agents) => setAnimAgents(agents)}
          onAskAI={!showAskAIButton ? undefined : (seg) => {
            // Build a concrete, context-rich seed so the assistant has the
            // numbers it needs without the user re-typing them.
            const stress = Math.round(seg.stress_pct);
            const delta = Math.round(seg.delta_pct);
            const deltaStr = delta > 0 ? ` (+${delta}% vs baseline)` : delta < 0 ? ` (${delta}% vs baseline)` : "";
            const line = seg.line_name ? ` on ${seg.line_name}` : "";
            setAiSeed(
              `In my simulation, the segment ${seg.from_stop} → ${seg.to_stop}${line} is at ${stress}% load${deltaStr}. What's likely causing this and what could I change to relieve it?`
            );
            setShowAIChat(true);
          }}
        />
      </div>

      {/* Plans panel — slides in from the right */}
      <div
        className={`pointer-events-none absolute right-6 bottom-6 flex items-start transition-all duration-300 ease-in-out z-10 ${
          showPlansPanel && !selectedRoute && !showGeneratedPanel ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
        style={{ top: "80px" }}
      >
        <PlansPanel
          open={showPlansPanel}
          routes={routes}
          hiddenRoutes={hiddenRoutes}
          transferExclusions={transferExclusions}
          currentPlanId={currentPlanId}
          planIsDirty={planIsDirty}
          authUser={authUser ?? null}
          authLoading={authLoading}
          onClose={() => setShowPlansPanel(false)}
          onPlanLoaded={handleLoadPlan}
          onCurrentPlanIdChange={setCurrentPlanId}
          onMarkSaved={(r) => { lastSavedRoutesRef.current = r; }}
          onNewPlan={handleNewPlan}
          darkMode={darkMode}
        />
      </div>

      {/* Ask AI chat — floating, draggable, self-positioning.
          Collision avoidance: when the right rail is occupied (a Sim/Plans/
          Route/Generated panel is open), the panel slides left to avoid overlap. */}
      {showAIChat && (
        <AIChatPanel
          routes={routes}
          onClose={() => { setShowAIChat(false); setAiSeed(null); }}
          seed={aiSeed}
          onSeedConsumed={() => setAiSeed(null)}
          avoidRightRail={
            showSimPanel || showPlansPanel || selectedRoute !== null || showGeneratedPanel
          }
        />
      )}

      {/* Map right-click context menu. Positioned at the cursor; closes on
          outside-click via the map listeners installed above, or on Escape.
          Only meaningful when Ask AI is enabled — its sole action is "Ask AI about here". */}
      {mapCtxMenu && showAskAIButton && (
        <div
          className="pointer-events-auto fixed z-40 min-w-44 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg"
          style={{ left: Math.min(mapCtxMenu.x, window.innerWidth - 200), top: Math.min(mapCtxMenu.y, window.innerHeight - 80) }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="border-b border-stone-100 px-3 py-2 text-[11px] text-stone-500">
            {mapCtxMenu.neighbourhood ?? `${mapCtxMenu.lat.toFixed(4)}, ${mapCtxMenu.lng.toFixed(4)}`}
          </div>
          <button
            onClick={() => {
              const label = mapCtxMenu.neighbourhood
                ? `About ${mapCtxMenu.neighbourhood} (${mapCtxMenu.lat.toFixed(4)}, ${mapCtxMenu.lng.toFixed(4)}): `
                : `About this location (${mapCtxMenu.lat.toFixed(4)}, ${mapCtxMenu.lng.toFixed(4)}): `;
              setAiSeed(label);
              setShowAIChat(true);
              setMapCtxMenu(null);
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-stone-700 hover:bg-teal-50 hover:text-teal-700"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5 text-teal-500">
              <path d="M8 1.5L9.5 6L14 7.5L9.5 9L8 13.5L6.5 9L2 7.5L6.5 6Z" />
            </svg>
            Ask AI about here
          </button>
        </div>
      )}

      {/* Side panel — only one shown at a time to prevent overlap */}
      <div
        className={`pointer-events-none absolute right-6 bottom-6 flex items-stretch transition-all duration-300 ease-in-out ${
          selectedRoute || showGeneratedPanel ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
        style={{ top: "80px" }}
      >
        {selectedRoute ? (
          <RoutePanel
            route={selectedRoute}
            selectedStopId={selectedStop}
            stationPopulations={stationPopulations}
            onDeleteStop={(stopId) => handleDeleteStop(stopId, selectedRoute.id)}
            onDeleteLine={() => handleDeleteCustomLine(selectedRoute.id)}
            onSnapToRoads={routes.some((r) => r.id === selectedRoute.id)
              ? () => handleSnapToRoads(selectedRoute)
              : undefined}
            onAddPortal={routes.some((r) => r.id === selectedRoute.id)
              ? () => { setAddPortalToLine(selectedRoute.id); addPortalToLineRef.current = selectedRoute.id; }
              : undefined}
            onClose={() => { setSelectedRouteId(null); setSelectedStop(null); }}
            allRoutes={routes}
            transferExclusions={transferExclusions}
            pedestrianConnections={(() => {
              // PEDESTRIAN_CONNECTIONS is authored by stop *name*, so resolve
              // the selected id back to a name before matching against it.
              const selectedName = selectedStop
                ? selectedRoute.stops.find((s) => s.id === selectedStop)?.name
                : undefined;
              if (!selectedName) return [];
              return PEDESTRIAN_CONNECTIONS.flatMap((conn) => {
                if (conn.routeAId === selectedRoute.id && conn.stopAName === selectedName) {
                  const r = routes.find((r) => r.id === conn.routeBId);
                  return r ? [{ route: r, stopName: conn.stopBName }] : [];
                }
                if (conn.routeBId === selectedRoute.id && conn.stopBName === selectedName) {
                  const r = routes.find((r) => r.id === conn.routeAId);
                  return r ? [{ route: r, stopName: conn.stopAName }] : [];
                }
                return [];
              });
            })()}
          />
        ) : showGeneratedPanel ? (
          <GeneratedRoutePanel
            route={generatedRoute!}
            disabledStops={disabledStops}
            selectedStop={selectedGeneratedStop}
            onToggleStop={handleToggleStop}
            onSelectStop={setSelectedGeneratedStop}
            onRename={(name: string) => setGeneratedRoute((r) => r ? { ...r, name } : r)}
            onDelete={() => setGeneratedRoute(null)}
            onClose={() => setGeneratedRoute(null)}
          />
        ) : null}
      </div>

      {/* Custom map controls — bottom right */}
      <div
        className="pointer-events-none absolute bottom-6 flex flex-col gap-1 transition-[right] duration-300 ease-in-out"
        style={{ right: selectedRoute || showGeneratedPanel ? "354px" : "24px" }}
      >
        {/* Bird's eye toggle */}
        <button
          onClick={() => {
            const map = mapRef.current;
            if (!map) return;
            const next = !isBirdsEye;
            setIsBirdsEye(next);
            map.easeTo({ pitch: next ? 0 : 40, bearing: next ? 0 : -10, duration: 600 });
          }}
          title="Bird's eye view"
          className={`pointer-events-auto flex h-[38px] w-[38px] items-center justify-center rounded-xl shadow transition-all ${
            isBirdsEye ? "bg-stone-800 text-white" : "bg-white text-stone-600 hover:bg-stone-50"
          }`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        {/* Zoom controls */}
        <div className="pointer-events-auto flex flex-col overflow-hidden rounded-xl shadow">
          <button
            onClick={() => mapRef.current?.zoomIn()}
            title="Zoom in"
            className="flex h-[38px] w-[38px] items-center justify-center bg-white text-stone-600 text-lg font-light hover:bg-stone-50 border-b border-stone-200"
          >+</button>
          <button
            onClick={() => mapRef.current?.zoomOut()}
            title="Zoom out"
            className="flex h-[38px] w-[38px] items-center justify-center bg-white text-stone-600 text-lg font-light hover:bg-stone-50"
          >−</button>
        </div>
      </div>

      {/* Generate Route / View Council — bottom centre */}
      {(hasSelection || councilHasRun) && (
        <div className="pointer-events-none absolute bottom-16 left-0 right-0 flex flex-col items-center gap-2">
          {hasSelection && !councilOpen && (
            <p className="text-[11px] text-stone-500 dark:text-stone-400 bg-black/10 dark:bg-white/10 backdrop-blur-sm rounded-full px-3 py-0.5">Experimental feature</p>
          )}
          <div className="flex gap-3">
          {hasSelection && !councilOpen && (
            <>
              {!councilRunning && !councilHasRun && (
                <button
                  onClick={handleGenerate}
                  className="pointer-events-auto flex h-13 items-center gap-3 rounded-xl bg-stone-900 px-8 text-base font-medium text-white shadow-lg transition-all hover:bg-stone-800"
                >
                  <span className="text-xl">✦</span>
                  Generate Route
                </button>
              )}
              {councilRunning && (
                <button
                  onClick={handleViewCouncil}
                  className="pointer-events-auto flex h-13 items-center gap-3 rounded-xl border border-stone-300 bg-white px-6 text-base font-medium text-stone-700 shadow-lg transition-all hover:bg-stone-50"
                >
                  <span className="inline-flex h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
                  Route generating…
                </button>
              )}
              {!councilRunning && councilHasRun && (
                <button
                  onClick={handleViewCouncil}
                  className="pointer-events-auto flex h-13 items-center gap-3 rounded-xl border border-stone-300 bg-white px-6 text-base font-medium text-stone-700 shadow-lg transition-all hover:bg-stone-50"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2"/>
                  </svg>
                  View Council
                </button>
              )}
            </>
          )}
          </div>
        </div>
      )}


      {/* Station popup */}
      {stationPopup && (() => {
        // True only for user-drawn custom routes; generated route stops are read-only.
        const isCustom = routes.some(r => r.id === stationPopup.routeId);
        const walkinConnections = PEDESTRIAN_CONNECTIONS.flatMap((conn) => {
          if (conn.routeAId === stationPopup.routeId && conn.stopAName === stationPopup.name) {
            const r = routes.find((r) => r.id === conn.routeBId);
            return r ? [{ route: r, stopName: conn.stopBName }] : [];
          }
          if (conn.routeBId === stationPopup.routeId && conn.stopBName === stationPopup.name) {
            const r = routes.find((r) => r.id === conn.routeAId);
            return r ? [{ route: r, stopName: conn.stopAName }] : [];
          }
          return [];
        });
        // The stops on other lines that are genuinely this same physical
        // station. Computed once and reused for the connection chips, "remove
        // from all lines" and cross-line rename, so all three agree.
        const counterparts = transferCounterparts(
          routes,
          stationPopup.routeId,
          { name: stationPopup.name, coords: stationPopup.coords },
          (otherRouteId) =>
            transferExclusions.has(
              transferExclusionKey(stationPopup.routeId, otherRouteId, stationPopup.name),
            ),
        );
        return (
          <StationPopup
            popup={stationPopup}
            allRoutes={generatedRoute ? [...routes, generatedRoute] : routes}
            isDeletable={isCustom}
            connectedRoutes={counterparts.map((c) => c.route)}
            pedestrianConnections={walkinConnections}
            onRemoveTransfer={(targetRouteId) => {
              const key = transferExclusionKey(stationPopup.routeId, targetRouteId, stationPopup.name);
              // Dismissals are undoable, so snapshot before mutating.
              snapshotHistory();
              setTransferExclusions((prev) => new Set([...prev, key]));
            }}
            onClose={() => setStationPopup(null)}
            onDelete={() => { handleDeleteStop(stationPopup.stopId, stationPopup.routeId); setStationPopup(null); }}
            onDeleteFromAll={() => {
              // This stop plus its co-located counterparts — not "every stop
              // anywhere that happens to share this name".
              handleDeleteStopsFromRoutes([
                { routeId: stationPopup.routeId, stopId: stationPopup.stopId },
                ...counterparts.flatMap((c) => c.stop.id ? [{ routeId: c.route.id, stopId: c.stop.id }] : []),
              ]);
              setStationPopup(null);
            }}
            onRename={(newName) => {
              // Rename this stop and the other lines' stops at the same physical
              // station (so a transfer keeps one shared name). Previously this
              // renamed every stop sharing the old name on every route, which
              // dragged unrelated stops along.
              const renameIds = new Set<string>([
                stationPopup.stopId,
                ...counterparts.flatMap((c) => c.stop.id ? [c.stop.id] : []),
              ]);
              snapshotHistory();
              setRoutes((prev) => prev.map((r) => ({
                ...r,
                stops: r.stops.map((s) => s.id && renameIds.has(s.id) ? { ...s, name: newName } : s),
              })));
              setGeneratedRoute((r) => r ? {
                ...r,
                stops: r.stops.map((s) => s.id && renameIds.has(s.id) ? { ...s, name: newName } : s),
              } : r);
              setStationPopup((p) => p ? { ...p, name: newName } : p);
            }}
            onAddTransfer={!isCustom ? undefined : (targetRouteId) => {
              const { name, coords } = stationPopup;
              // Read the pre-add route from the ref (not the `routes` closure) so
              // the re-snap decision below matches what triggerAutoSnap will see.
              const routeBeforeAdd = routesRef.current.find((r) => r.id === targetRouteId);
              // If the stop is already on this route the setRoutes map is a no-op,
              // so there's nothing new to snap — skip the road-route regeneration.
              const alreadyHasStop = routeBeforeAdd?.stops.some((s) => s.name === name) ?? false;
              snapshotHistory();
              setRoutes((prev) => prev.map((r) => {
                if (r.id !== targetRouteId) return r;
                if (r.stops.some((s) => s.name === name)) return r;
                // A distinct Stop object on the other route that deliberately
                // shares the name — co-location is what makes it a transfer.
                const newStop = { id: newStopId(), name, coords };
                if (r.stops.length === 0) return { ...r, stops: [newStop] };
                const roadSnapped = r.type === "bus" || r.type === "streetcar";
                // 📖 Learn: "minimum detour" insertion — for each gap between
                // consecutive stops, compute how much extra distance inserting here
                // costs: d(i→new) + d(new→i+1) - d(i→i+1). Pick the cheapest gap.
                // Also check prepending (before stop 0) and appending (after last stop).
                let bestIdx = r.stops.length; // default: append
                let bestCost = haversineKm(coords, r.stops[r.stops.length - 1]!.coords);
                // check prepend
                const prependCost = haversineKm(coords, r.stops[0]!.coords);
                if (prependCost < bestCost) { bestIdx = 0; bestCost = prependCost; }
                // check each interior gap
                for (let i = 0; i < r.stops.length - 1; i++) {
                  const a = r.stops[i]!.coords;
                  const b = r.stops[i + 1]!.coords;
                  const cost = haversineKm(coords, a) + haversineKm(coords, b) - haversineKm(a, b);
                  if (cost < bestCost) { bestIdx = i + 1; bestCost = cost; }
                }
                const newStops = [...r.stops.slice(0, bestIdx), newStop, ...r.stops.slice(bestIdx)];
                // Keep the old shape on screen while the re-snap runs (see below);
                // triggerAutoSnap overwrites it once the road route comes back.
                return { ...r, stops: newStops, shape: roadSnapped ? r.shape : undefined };
              }));
              // Bus/streetcar lines follow roads, so inserting a transfer stop
              // changes the path — re-run the road-snap exactly like placing a
              // stop by clicking the map does. Without this the line keeps its
              // old geometry and never routes through the new transfer station.
              if (
                !alreadyHasStop &&
                (routeBeforeAdd?.type === "bus" || routeBeforeAdd?.type === "streetcar") &&
                routeBeforeAdd.stops.length >= 1
              ) {
                startShimmerRef.current(targetRouteId);
                triggerAutoSnapRef.current(targetRouteId);
              }
              setStationPopup(null);
            }}
          />
        );
      })()}


      {/* Chat panel — bottom right, above zoom controls */}
      <ChatPanel
        open={councilOpen}
        onClose={() => {
          setCouncilOpen(false);
        }}
        startNew={councilStartNew}
        neighbourhoodNames={
          [...selectedNeighbourhoods].map(
            (code) => neighbourhoodsGeoJSONRef.current?.features.find(
              (f) => f.properties?.AREA_SHORT_CODE === code
            )?.properties?.AREA_NAME ?? code
          )
        }
        stationNames={[...selectedStations].map((s) => s.split("::")[0]!)}
        existingLineStops={routes.flatMap((r) =>
          r.stops.map((s) => ({ name: s.name, coords: s.coords, route: r.name }))
        )}
        routePanelOpen={generatedRoute !== null}
        randomizeSpeakingOrder={randomizeSpeakingOrder}
        onRoutePreview={(routes) => setCouncilPreview(routes)}
        onToolCall={(evt) => onToolCallRef.current(evt)}
        onAddRoute={(parsed: ParsedRoute) => {
          const id = `custom-${customLineCounterRef.current++}`;
          const stops = parsed.stops;
          let totalKm = 0;
          for (let i = 1; i < stops.length; i++) {
            totalKm += haversineKm(stops[i - 1]!.coords, stops[i]!.coords);
          }
          const costPerKm = parsed.type === "subway" ? 500 : (parsed.type === "streetcar" || parsed.type === "lrt") ? 80 : 4;
          const costM = Math.round(totalKm * costPerKm);
          const costStr = costM >= 1000 ? `$${(costM / 1000).toFixed(1)}B` : `$${costM}M`;
          const buildYears = parsed.type === "subway" ? Math.ceil(totalKm * 1.2 + 3) : (parsed.type === "streetcar" || parsed.type === "lrt") ? Math.ceil(totalKm * 0.6 + 2) : Math.ceil(totalKm * 0.1 + 1);
          const prRaw = parsed.prScore ?? 20;
          const prNorm = Math.round((prRaw / 40) * 10);
          const approvalChance = Math.max(15, Math.min(92, 85 - prRaw * 1.5));
          const minutesSaved = Math.round(totalKm * (parsed.type === "subway" ? 3.5 : 2));
          const dollarsSaved = `$${(minutesSaved * 0.3).toFixed(1)}/trip`;
          // AI-proposed stops arrive as bare {name, coords}. Id them once here:
          // the same array feeds both the editable route and the stats-panel
          // copy below, which share a route id and must agree on stop ids.
          const councilStops = parsed.stops.map((s) => ({ ...s, id: newStopId() }));
          const newCustomLine: Route = {
            id,
            name: parsed.name,
            shortName: parsed.name.slice(0, 2).toUpperCase(),
            color: parsed.color,
            textColor: "#ffffff",
            type: parsed.type,
            description: `${costStr} · ${buildYears}yr build · Approval ${Math.round(approvalChance)}% · PR ${prNorm}/10`,
            frequency: `−${minutesSaved}min commute`,
            stops: councilStops,
          };
          setRoutes((prev) => [...prev, newCustomLine]);
          trackEvent("Council Route Added", {
            ...getAnalyticsContext([...routesRef.current, newCustomLine]),
            route_id: id,
            route_name: parsed.name,
            route_type: parsed.type,
            station_count: parsed.stops.length,
            pr_score: parsed.prScore,
          });
          // Also set generatedRoute for the stats panel
          setGeneratedRoute({
            id,
            name: parsed.name,
            shortName: parsed.name.slice(0, 2).toUpperCase(),
            textColor: "#ffffff",
            description: `${costStr} · ${buildYears}yr build`,
            frequency: `−${minutesSaved}min commute`,
            color: parsed.color,
            type: parsed.type,
            stops: councilStops,
            stats: {
              cost: costStr,
              timeline: `${buildYears} yrs`,
              costedTimeline: `${Math.ceil(buildYears * 1.3)} yrs w/ contingency`,
              minutesSaved,
              dollarsSaved,
              percentageChance: Math.round(approvalChance),
              prNightmareScore: prNorm,
            },
          });
          setCouncilHasRun(true);
          setCouncilRunning(false);
          clearNeighbourhoodSelectionAfterGeneration();
        }}
      />

      {/* Import / Export — top right */}
      <div className="pointer-events-none absolute top-5 right-6 z-10 flex items-start gap-2">

        {/* ── Wide screens: two full-width buttons ── */}
        <button
          onClick={handleImport}
          className="pointer-events-auto hidden lg:flex h-13 items-center gap-2 rounded-xl border border-[#D7D7D7] bg-white px-4 text-base font-normal text-stone-500 shadow-sm hover:text-stone-800 transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2v8M5 7l3 3 3-3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
          </svg>
          Import
        </button>
        <div className="pointer-events-auto hidden lg:flex flex-col gap-1.5">
          <button
            onClick={handleExport}
            disabled={exportProgress !== null}
            className="flex h-13 items-center gap-2 rounded-xl border border-[#D7D7D7] bg-white px-4 text-base font-normal text-stone-500 shadow-sm hover:text-stone-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 10V2M5 5l3-3 3 3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
            </svg>
            Export
            {hasUnsaved && (
              <span className="ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" title="Unsaved changes" />
            )}
          </button>
          {exportProgress !== null && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-stone-200">
              <div
                className="h-full rounded-full bg-stone-700 transition-all duration-150"
                style={{ width: `${exportProgress}%` }}
              />
            </div>
          )}
        </div>

        {/* ── Narrow screens: single icon button → dropdown ── */}
        <div ref={ieDropdownRef} className="pointer-events-auto relative lg:hidden">
          <button
            onClick={() => setShowIEDropdown((v) => !v)}
            className="flex h-13 w-13 items-center justify-center rounded-xl border border-[#D7D7D7] bg-white text-stone-500 shadow-sm hover:text-stone-800 transition-colors"
            aria-label="Import / Export"
          >
            {/* Upload/download stacked arrows */}
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 6l3-3 3 3M11 10l-3 3-3-3"/>
            </svg>
            {hasUnsaved && (
              <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-amber-400" />
            )}
          </button>

          {showIEDropdown && (
            <div className="absolute right-0 top-full mt-1.5 w-44 overflow-hidden rounded-xl border border-[#D7D7D7] bg-white shadow-lg">
              <button
                onClick={() => { setShowIEDropdown(false); handleImport(); }}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-800 transition-colors"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v8M5 7l3 3 3-3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
                </svg>
                Import
              </button>
              <div className="mx-3 h-px bg-stone-100" />
              <button
                onClick={() => { setShowIEDropdown(false); handleExport(); }}
                disabled={exportProgress !== null}
                className="flex w-full items-center gap-3 px-4 py-3 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 10V2M5 5l3-3 3 3"/><rect x="2" y="11" width="12" height="3" rx="1" fill="none"/>
                </svg>
                Export
                {hasUnsaved && (
                  <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                )}
              </button>
              {exportProgress !== null && (
                <div className="mx-3 mb-2 h-1 overflow-hidden rounded-full bg-stone-200">
                  <div
                    className="h-full rounded-full bg-stone-700 transition-all duration-150"
                    style={{ width: `${exportProgress}%` }}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Settings menu ── */}
        <div ref={settingsMenuRef} className="pointer-events-auto relative">
          <button
            onClick={() => setShowSettingsMenu((v) => !v)}
            className={`flex h-13 w-13 items-center justify-center rounded-xl border bg-white shadow-sm transition-colors ${showSettingsMenu ? "border-stone-400 text-stone-800" : "border-[#D7D7D7] text-stone-500 hover:text-stone-800"}`}
            aria-label="Settings"
          >
            <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>

          {showSettingsMenu && (
            <div className="max-h-[calc(75vh-5rem)] overflow-y-auto absolute right-0 top-full mt-1.5 w-60 rounded-xl border border-[#D7D7D7] bg-white shadow-lg z-30">
              {/* Account section */}
              <div className="px-4 py-3 border-b border-stone-100">
                {authLoading ? (
                  <div className="h-8 w-full animate-pulse rounded-lg bg-stone-100" />
                ) : authUser ? (
                  <div className="flex items-center gap-2.5">
                    {authUser.picture ? (
                      <Image src={authUser.picture} alt={authUser.name ?? "User"} width={32} height={32} className="h-8 w-8 rounded-full object-cover shrink-0" />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-600">
                        {(authUser.name ?? authUser.email ?? "U")[0]?.toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1 flex flex-col justify-center">
                      <p className="truncate text-sm font-medium text-stone-800 leading-none">{authUser.name ?? authUser.email}</p>
                      <a href="/auth/logout" className="text-xs text-stone-400 hover:text-stone-600 transition-colors leading-none mt-0.5">Sign out</a>
                    </div>
                  </div>
                ) : (
                  <a
                    href="/auth/login?returnTo=/map"
                    className="flex w-full items-center gap-2 rounded-lg bg-stone-800 px-3 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
                  >
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="8" cy="5" r="3" /><path d="M2 13.5c0-2.5 2.7-4.5 6-4.5s6 2 6 4.5" />
                    </svg>
                    Sign in
                  </a>
                )}
              </div>

              {/* Map layers moved to the top-toolbar Layers dropdown. */}

              {/* App settings */}
              <div className="border-b border-stone-100 py-1">
                <p className="px-4 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-stone-300">App</p>
                {([
                  ["Dark mode", darkMode, () => setDarkMode((v) => !v), false],
                  ["High contrast", highContrast, () => setHighContrast((v) => !v), false],
                  ["Imperial units", imperial, () => setImperial((v) => !v), false],
                  ["Analysis panel", advancedMode, () => { const next = !advancedMode; setAdvancedMode(next); setExperimentalFeatures(next); }, false],
                  ["Ask AI", showAskAIButton, () => setShowAskAIButton((v) => !v), true],
                  ["GO Transit", showGoTrain, () => setShowGoTrain((v) => !v), true],
                ] as [string, boolean, () => void, boolean][]).map(([label, on, toggle, beta]) => (
                  <button key={label} onClick={toggle} className="flex w-full items-center justify-between px-4 py-2 text-sm text-stone-600 hover:bg-stone-50 transition-colors">
                    <span className="flex items-center gap-1.5">
                      {label}
                      {beta && <span className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-bold text-violet-600 uppercase tracking-wide">beta</span>}
                    </span>
                    <span className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${highContrast ? (on ? "bg-yellow-400" : "bg-black ring-2 ring-white") : (on ? "bg-stone-700" : "bg-stone-200")}`}>
                      <span className={`absolute top-0.5 h-3 w-3 rounded-full shadow transition-transform ${highContrast ? (on ? "bg-black translate-x-3.5" : "bg-[#ffffff] translate-x-0.5") : (on ? "bg-white translate-x-3.5" : "bg-white translate-x-0.5")}`} />
                    </span>
                  </button>
                ))}
                {/* AI provider selector — two-option pill toggle */}
                <div className="flex items-center justify-between px-4 py-2">
                  <span className="text-sm text-stone-600">AI provider</span>
                  <div className="flex rounded-full border border-stone-200 overflow-hidden text-xs font-medium">
                    {(["anthropic", "gemini"] as const).map((p) => (
                      <button
                        key={p}
                        onClick={() => setAiProvider(p)}
                        className={`px-2.5 py-1 capitalize transition-colors ${aiProvider === p ? "bg-stone-700 text-white" : "text-stone-500 hover:bg-stone-50"}`}
                      >
                        {p === "anthropic" ? "Claude" : "Gemini"}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Advanced — collapsed by default; disclosure pattern keeps settings tidy. */}
              <div className="border-b border-stone-100 py-1">
                <button
                  type="button"
                  className="flex w-full items-center justify-between px-4 py-2 text-left hover:bg-stone-50 transition-colors"
                  aria-expanded={advancedSettingsExpanded}
                  onClick={() => setAdvancedSettingsExpanded((v) => !v)}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-300">Advanced</span>
                  <svg
                    viewBox="0 0 12 12"
                    fill="none"
                    className={`h-4 w-4 shrink-0 text-stone-400 transition-transform ${advancedSettingsExpanded ? "rotate-180" : ""}`}
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M3 4.5l3 3 3-3" />
                  </svg>
                </button>
                {advancedSettingsExpanded && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRandomizeSpeakingOrder((v) => !v);
                    }}
                    className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm text-stone-600 hover:bg-stone-50 transition-colors"
                  >
                    <span className="min-w-0 flex-1 text-left">
                      Randomize council speaking order
                    </span>
                    <span
                      className={`relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors ${highContrast ? (randomizeSpeakingOrder ? "bg-yellow-400" : "bg-black ring-2 ring-white") : randomizeSpeakingOrder ? "bg-stone-700" : "bg-stone-200"}`}
                    >
                      <span className={`absolute top-0.5 h-3 w-3 rounded-full shadow transition-transform ${highContrast ? (randomizeSpeakingOrder ? "bg-black translate-x-3.5" : "bg-[#ffffff] translate-x-0.5") : randomizeSpeakingOrder ? "bg-white translate-x-3.5" : "bg-white translate-x-0.5"}`} />
                    </span>
                  </button>
                )}
              </div>

              {/* Danger zone */}
              <div className="border-b border-stone-100 py-1">
                <button
                  onClick={() => { setShowResetConfirm(true); setShowSettingsMenu(false); }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-red-500 hover:bg-red-50 transition-colors"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-9" />
                  </svg>
                  Reset project
                </button>
              </div>

              {/* Feedback / Bug report */}
              <div className="py-1">
                <button
                  onClick={() => { setShowChangelog(true); setShowSettingsMenu(false); }}
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors"
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 6v4M8 5v.5" />
                  </svg>
                  What's new
                </button>
                <a
                  href="/docs"
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors"
                  onClick={() => setShowSettingsMenu(false)}
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 2h12v12H2zM2 6h12M6 6v8" />
                  </svg>
                  Docs
                </a>
                <a
                  href="mailto:richardli0@outlook.com"
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors"
                  onClick={() => setShowSettingsMenu(false)}
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="1" y="3" width="14" height="10" rx="1.5" /><path d="M1 4l7 5 7-5" />
                  </svg>
                  Contact us
                </a>
                <button
                  className="flex w-full items-center gap-3 px-4 py-2 text-sm text-stone-500 hover:bg-stone-50 hover:text-stone-700 transition-colors"
                  onClick={() => { setShowFeedback(true); setShowSettingsMenu(false); }}
                >
                  <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 8c0 3.314-2.686 6-6 6a6.003 6.003 0 0 1-5.197-3L2 12l1.197-2.803A6 6 0 1 1 14 8z" />
                  </svg>
                  Give feedback
                </button>
              </div>
            </div>
          )}
        </div>

      </div>


      {/* Import confirmation modal */}
      {pendingImportFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-6 w-full max-w-md rounded-2xl border border-[#D7D7D7] bg-white p-8 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-amber-100">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-amber-600">
                  <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-800">Import {pendingImportFile.name}</p>
                <p className="mt-1 text-sm leading-relaxed text-stone-500">
                  <span className="font-medium text-stone-700">Replace</span> removes all current lines first.{" "}
                  <span className="font-medium text-stone-700">Merge</span> adds incoming routes alongside existing ones, overwriting any with the same ID.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingImportFile(null)}
                className="rounded-xl border border-[#D7D7D7] px-5 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => confirmImport(pendingImportFile, true)}
                className="rounded-xl border border-[#D7D7D7] px-5 py-2 text-sm font-medium text-stone-700 hover:bg-stone-50 transition-colors"
              >
                Merge & import
              </button>
              <button
                onClick={() => confirmImport(pendingImportFile, false)}
                className="rounded-xl bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
              >
                Replace & import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import error modal */}
      {importError && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-6 w-full max-w-md rounded-2xl border border-[#D7D7D7] bg-white p-8 shadow-2xl">
            <div className="mb-4 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5 text-red-600">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm-.75-10.5a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4zm.75 7a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-stone-800">Import failed</p>
                <p className="mt-1 text-sm leading-relaxed text-stone-500">{importError}</p>
              </div>
            </div>
            <div className="flex justify-end">
              <button
                onClick={() => setImportError(null)}
                className="rounded-xl bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* GTFS Validation modal */}
      {/* GTFS validation — success toast (near export button) */}
      {validationResult?.result.valid && (
        <div className="pointer-events-auto absolute top-20 right-6 z-50 w-72 rounded-xl border border-[#D7D7D7] bg-white p-4 shadow-lg">
          <div className="flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-100">
              <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 text-green-600" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2.5,8.5 6,12 13.5,4" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-stone-800">
                {validationResult.context === "export" ? "Exported" : "Imported"} successfully
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-stone-500">
                <span>{validationResult.result.stats.routes} routes</span>
                <span>{validationResult.result.stats.trips} trips</span>
                <span>{validationResult.result.stats.stops} stops</span>
                {validationResult.result.stats.shapes > 0 && (
                  <span>{validationResult.result.stats.shapes} shape pts</span>
                )}
              </div>
            </div>
            <button
              onClick={() => setValidationResult(null)}
              className="ml-1 shrink-0 text-stone-400 hover:text-stone-700 transition-colors"
              aria-label="Dismiss"
            >
              <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" /><line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* GTFS validation — error/warning full modal */}
      {validationResult && !validationResult.result.valid && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-6 w-full max-w-lg rounded-2xl border border-[#D7D7D7] bg-white p-8 shadow-2xl">
            <div className="mb-5 flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-100">
                <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 text-red-600" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="8" cy="8" r="6" />
                  <line x1="8" y1="5" x2="8" y2="8.5" />
                  <circle cx="8" cy="11" r="0.5" fill="currentColor" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-base font-semibold text-stone-800">
                  GTFS Validation — {validationResult.context === "export" ? "Export" : "Import"}
                  {validationResult.context === "import" && " blocked"}
                </p>
                {/* Stats row */}
                <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm text-stone-500">
                  <span>{validationResult.result.stats.routes} routes</span>
                  <span>{validationResult.result.stats.trips} trips</span>
                  <span>{validationResult.result.stats.stops} stops</span>
                  <span>{validationResult.result.stats.stopTimes.toLocaleString()} stop-times</span>
                  {validationResult.result.stats.shapes > 0 && (
                    <span>{validationResult.result.stats.shapes} shape pts</span>
                  )}
                </div>
                {/* Issue counts */}
                <div className="mt-2 flex gap-3 text-sm">
                  {(() => {
                    const errors   = validationResult.result.issues.filter((i) => i.severity === "error").length;
                    const warnings = validationResult.result.issues.filter((i) => i.severity === "warning").length;
                    return (
                      <>
                        {errors > 0   && <span className="font-medium text-red-600">{errors} error{errors !== 1 ? "s" : ""}</span>}
                        {warnings > 0 && <span className="font-medium text-amber-600">{warnings} warning{warnings !== 1 ? "s" : ""}</span>}
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>

            {/* Issue list */}
            {validationResult.result.issues.length > 0 && (
              <ul className="mb-5 max-h-56 overflow-y-auto space-y-1.5 rounded-xl bg-stone-50 p-3">
                {validationResult.result.issues.map((issue, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={`mt-px shrink-0 font-mono font-semibold ${issue.severity === "error" ? "text-red-500" : "text-amber-500"}`}>
                      {issue.code}
                    </span>
                    <span className="text-stone-600 leading-relaxed">{issue.message}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex justify-end">
              <button
                onClick={() => setValidationResult(null)}
                className="rounded-xl bg-stone-800 px-5 py-2 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
              >
                {validationResult.context === "import" ? "Cancel import" : "Dismiss"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* New line modal */}
      {showNewLineModal && (
        <NewLineModal
          onClose={() => setShowNewLineModal(false)}
          onConfirm={(name, color, type, shortName) => {
            const id = `custom-${customLineCounterRef.current++}`;
            const newRoute: Route = {
              id,
              name,
              shortName,
              color,
              textColor: "#ffffff",
              type,
              description: "Custom line",
              frequency: "—",
              stops: [],
            };
            setRoutes((prev) => [...prev, newRoute]);
            trackEvent("Line Created", {
              ...getAnalyticsContext([...routesRef.current, newRoute]),
              route_id: id,
              route_name: name,
              route_type: type,
              short_name: shortName,
              color,
              creation_source: "manual",
            });
            handleSetDrawMode("normal");
            setAddStationToLine(id);
            setShowNewLineModal(false);
          }}
        />
      )}

      {/* Mobile nav — only rendered below the md breakpoint (768px) */}
      <div className="md:hidden">
        <MobileNav
          routes={routes}
          onNewLine={() => setShowNewLineModal(true)}
          showHeatmap={showHeatmap}
          onToggleHeatmap={() => setShowHeatmap((v) => !v)}
          showTraffic={showTraffic}
          onToggleTraffic={() => setShowTraffic((v) => !v)}
          darkMode={darkMode}
          onToggleDarkMode={() => setDarkMode((v) => !v)}
          onResetProject={() => setShowResetConfirm(true)}
          drawMode={drawMode}
          onSetDrawMode={handleSetDrawMode}
          onOpenGameMode={() => setShowGameMode(true)}
        />
      </div>

      {/* Agent animation controls */}
      {animAgents && (
        <div className="pointer-events-auto absolute bottom-8 left-1/2 -translate-x-1/2 flex items-center gap-3 rounded-2xl border border-[#D7D7D7] bg-white px-5 py-3 shadow-xl">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-100">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="9" />
            </svg>
          </div>
          <div className="text-sm text-stone-700">
            Animating <span className="font-semibold text-indigo-700">{new Set(animAgents.map((a) => a.agent_id)).size.toLocaleString()}</span> agents
          </div>
          {animClockLabel && (
            <div className="rounded-lg bg-stone-900 px-2.5 py-1 font-mono text-sm font-semibold text-white tabular-nums">
              {animClockLabel}
            </div>
          )}
          <div className="flex items-center gap-2 text-[11px] text-stone-400">
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-orange-400" /> Low-income</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-teal-500" /> Mid-income</span>
            <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-cyan-500" /> High-income</span>
          </div>
          <button
            onClick={() => {
              setAnimAgents(null);
            }}
            className="ml-2 rounded-lg px-3 py-1 text-xs font-medium text-stone-500 hover:bg-stone-100 transition-colors"
          >
            Stop
          </button>
          <button
            onClick={() => {
              animStartRef.current = null;
              setAnimAgents([...animAgents]);
            }}
            className="rounded-lg px-3 py-1 text-xs font-medium bg-indigo-600 text-white hover:bg-indigo-700 transition-colors"
          >
            Replay
          </button>
        </div>
      )}
    </div>
  );
}
