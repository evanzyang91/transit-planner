"use client";

import MapboxDraw from "@mapbox/mapbox-gl-draw";
import "@mapbox/mapbox-gl-draw/dist/mapbox-gl-draw.css";
import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";

type DrawMode = "normal" | "select" | "boundary";

import {
  GENERATED_ROUTES,
  NEIGHBOURHOOD_DATA,
  POPULATION_POINTS,
  ROUTES,
  type GeneratedRoute,
  type Route,
} from "~/app/map/mock-data";
import {
  findNeighbourhoodPath,
  TORONTO_NEIGHBOURHOODS,
} from "~/app/map/toronto-neighbourhoods";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";
const TORONTO: [number, number] = [-79.3832, 43.6532];

// ─── helpers ─────────────────────────────────────────────────────────────────

function routeToGeoJSON(route: Route): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: "Feature",
    properties: { id: route.id },
    geometry: { type: "LineString", coordinates: route.stops.map((s) => s.coords) },
  };
}

function stopsToGeoJSON(route: Route): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: route.stops.map((s) => ({
      type: "Feature",
      properties: { name: s.name, routeId: route.id, color: route.color },
      geometry: { type: "Point", coordinates: s.coords },
    })),
  };
}

const TYPE_LABEL: Record<Route["type"], string> = {
  subway: "Subway",
  streetcar: "Streetcar",
  bus: "Bus",
};

// ─── stat bar ─────────────────────────────────────────────────────────────────

function StatBar({ value, max, color }: { value: number; max: number; color: string }) {
  return (
    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
      <div
        className="h-1.5 rounded-full"
        style={{ width: `${(value / max) * 100}%`, background: color }}
      />
    </div>
  );
}

// ─── neighbourhood panel ──────────────────────────────────────────────────────

const TRAFFIC_COLOR: Record<string, string> = {
  "Low": "#22c55e",
  "Moderate": "#f59e0b",
  "High": "#f97316",
  "Very High": "#ef4444",
};

function NeighbourhoodPanel({
  id,
  name,
  onClose,
}: {
  id: string;
  name: string;
  onClose: () => void;
}) {
  const data = NEIGHBOURHOOD_DATA[id];
  const transitLines = ROUTES.filter((r) => data?.transitLines.includes(r.id));

  return (
    <div className="pointer-events-auto w-72 overflow-hidden rounded-2xl bg-white shadow-2xl" style={{ border: "0.93px solid #BEB7B4" }}>
      {/* Preview image */}
      <div className="relative h-36">
        <img src="/placeholder.png" alt="Neighbourhood view" className="h-full w-full object-cover" />
        <button
          onClick={onClose}
          className="absolute top-3 right-3 flex h-7 w-7 items-center justify-center rounded-full bg-white/80 text-stone-500 hover:bg-white hover:text-stone-800"
        >
          ✕
        </button>
      </div>

      <div className="px-5 pt-4 pb-5 space-y-4">
        <h2 className="text-base font-semibold text-stone-800">{name}</h2>

        {data ? (
          <>
            <div className="space-y-2.5">
              {/* Traffic */}
              <div className="flex justify-between text-xs">
                <span className="text-stone-500">Traffic levels</span>
                <span className="font-semibold" style={{ color: TRAFFIC_COLOR[data.trafficLevel] }}>
                  {data.trafficLevel}
                </span>
              </div>

              {/* Employment */}
              <div className="flex justify-between text-xs">
                <span className="text-stone-500">Employment density</span>
                <span className="font-semibold text-stone-800">{data.employmentDensity}</span>
              </div>

              {/* Population */}
              <div className="flex justify-between text-xs">
                <span className="text-stone-500">Population density</span>
                <span className="font-semibold text-stone-800">{data.populationDensity.toLocaleString()} / km²</span>
              </div>

              {/* Connectivity */}
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-stone-500">How connected it is</span>
                  <span className="font-semibold text-stone-800">{data.connectivityScore}/10</span>
                </div>
                <StatBar value={data.connectivityScore} max={10} color="#6366f1" />
              </div>
            </div>

            {/* Transit lines */}
            {transitLines.length > 0 && (
              <div>
                <p className="mb-2 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
                  Lines in the area
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {transitLines.map((r) => (
                    <span
                      key={r.id}
                      className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
                      style={{ background: r.color + "22", color: r.color }}
                    >
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: r.color }} />
                      {r.shortName}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-stone-400">No data available</p>
        )}
      </div>
    </div>
  );
}

// ─── existing route panel ────────────────────────────────────────────────────

function RoutePanel({ route, onClose }: { route: Route; onClose: () => void }) {
  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col overflow-hidden rounded-[30px] bg-white shadow-2xl" style={{ border: "0.93px solid #BEB7B4" }}>
      <div className="flex items-start justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: route.color, color: route.textColor }}
          >
            {route.shortName}
          </span>
          <div>
            <p className="text-[11px] font-medium tracking-widest text-stone-400 uppercase">
              {TYPE_LABEL[route.type]}
            </p>
            <h2 className="text-base font-semibold leading-tight text-stone-800">{route.name}</h2>
          </div>
        </div>
        <button
          onClick={onClose}
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      <div className="mx-5 h-0.5 rounded-full" style={{ background: route.color }} />

      <div className="px-5 pt-3 pb-2">
        <p className="text-sm leading-relaxed text-stone-500">{route.description}</p>
        <p className="mt-2 text-xs font-medium text-stone-400">
          Frequency: <span className="text-stone-600">{route.frequency}</span>
        </p>
      </div>

      <div className="mt-2 flex-1 overflow-y-auto px-5 pb-5">
        <p className="mb-2 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
          Stops ({route.stops.length})
        </p>
        <ol className="relative border-l-2" style={{ borderColor: route.color + "44" }}>
          {route.stops.map((stop, i) => (
            <li key={stop.name} className="mb-0 flex items-center">
              <span
                className="absolute -left-[5px] h-2.5 w-2.5 rounded-full border-2 bg-white"
                style={{
                  borderColor:
                    i === 0 || i === route.stops.length - 1 ? route.color : route.color + "88",
                }}
              />
              <span className="py-1.5 pl-4 text-sm text-stone-700">{stop.name}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

// ─── generated route stats panel ─────────────────────────────────────────────

function GeneratedRoutePanel({
  route,
  disabledStops,
  isGenerating,
  onToggleStop,
  onClose,
  onRegenerate,
}: {
  route: GeneratedRoute;
  disabledStops: Set<string>;
  isGenerating: boolean;
  onToggleStop: (name: string) => void;
  onClose: () => void;
  onRegenerate: () => void;
}) {
  const { stats } = route;
  const prColor =
    stats.prNightmareScore < 4
      ? "#22c55e"
      : stats.prNightmareScore < 7
        ? "#f59e0b"
        : "#ef4444";
  const chanceColor =
    stats.percentageChance > 65 ? "#22c55e" : stats.percentageChance > 40 ? "#f59e0b" : "#ef4444";

  return (
    <div className="pointer-events-auto flex h-full w-80 flex-col overflow-hidden rounded-[30px] bg-white shadow-2xl" style={{ border: "0.93px solid #BEB7B4" }}>
      {/* Header */}
      <div className="flex items-start justify-between px-5 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: route.color, color: route.textColor }}
          >
            {route.shortName}
          </span>
          <div>
            <p className="flex items-center gap-1 text-[11px] font-medium tracking-widest text-stone-400 uppercase">
              <span>✦</span> AI Generated
            </p>
            <h2 className="text-base font-semibold leading-tight text-stone-800">{route.name}</h2>
          </div>
        </div>
        <button
          onClick={onClose}
          className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-700"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      <div className="mx-5 h-0.5 rounded-full" style={{ background: route.color }} />

      <div className="px-5 pt-3 pb-2">
        <p className="text-sm leading-relaxed text-stone-500">{route.description}</p>
      </div>

      {/* Stats */}
      <div className="border-b border-stone-100 px-5 pb-4">
        <p className="mb-3 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
          Route Analysis
        </p>
        <div className="space-y-3">
          <div className="flex justify-between text-xs">
            <span className="text-stone-500">Cost</span>
            <span className="font-semibold text-stone-800">{stats.cost}</span>
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <span className="text-stone-500">Timeline</span>
              <span className="font-semibold text-stone-800">{stats.timeline}</span>
            </div>
            <div className="flex justify-between text-[11px] mt-0.5">
              <span className="italic text-stone-400">w/ contingency</span>
              <span className="text-stone-500">{stats.costedTimeline}</span>
            </div>
          </div>

          <div className="flex justify-between text-xs">
            <span className="text-stone-500">Minutes Saved</span>
            <span className="font-semibold text-stone-800">{stats.minutesSaved} min/trip</span>
          </div>

          <div className="flex justify-between text-xs">
            <span className="text-stone-500">Dollars Saved</span>
            <span className="font-semibold text-stone-800">{stats.dollarsSaved}</span>
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <span className="text-stone-500">Approval Chance</span>
              <span className="font-semibold" style={{ color: chanceColor }}>
                {stats.percentageChance}%
              </span>
            </div>
            <StatBar value={stats.percentageChance} max={100} color={chanceColor} />
          </div>

          <div>
            <div className="flex justify-between text-xs">
              <span className="text-stone-500">PR Nightmare Score</span>
              <span className="font-semibold" style={{ color: prColor }}>
                {stats.prNightmareScore}/10
              </span>
            </div>
            <StatBar value={stats.prNightmareScore} max={10} color={prColor} />
          </div>
        </div>
      </div>

      {/* Editable stops */}
      <div className="mt-2 flex-1 overflow-y-auto px-5 pb-3">
        <p className="mb-2 text-[11px] font-semibold tracking-widest text-stone-400 uppercase">
          Stops — click to toggle
        </p>
        <ol className="relative border-l-2" style={{ borderColor: route.color + "44" }}>
          {route.stops.map((stop, i) => {
            const off = disabledStops.has(stop.name);
            return (
              <li
                key={stop.name}
                className="group mb-0 flex cursor-pointer items-center"
                onClick={() => onToggleStop(stop.name)}
              >
                <span
                  className="absolute -left-[5px] h-2.5 w-2.5 rounded-full border-2 bg-white"
                  style={{
                    borderColor: off
                      ? "#d1d5db"
                      : i === 0 || i === route.stops.length - 1
                        ? route.color
                        : route.color + "88",
                  }}
                />
                <span
                  className={`py-1.5 pl-4 text-sm transition-colors ${
                    off
                      ? "text-stone-300 line-through"
                      : "text-stone-700 group-hover:text-stone-900"
                  }`}
                >
                  {stop.name}
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {/* Regenerate */}
      <div className="border-t border-stone-100 px-5 py-3">
        <button
          onClick={onRegenerate}
          disabled={isGenerating}
          className="flex w-full items-center justify-center gap-2 rounded-lg py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 active:opacity-80 disabled:opacity-50"
          style={{ background: route.color }}
        >
          {isGenerating ? (
            <>
              <span className="inline-block animate-spin">⟳</span> Generating…
            </>
          ) : (
            <>✦ Regenerate</>
          )}
        </button>
      </div>
    </div>
  );
}

// ─── main map component ──────────────────────────────────────────────────────

export function TransitMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const drawRef = useRef<MapboxDraw | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [generatedRoute, setGeneratedRoute] = useState<GeneratedRoute | null>(null);
  const [disabledStops, setDisabledStops] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [drawMode, setDrawMode] = useState<DrawMode>("normal");
  const [hasBoundary, setHasBoundary] = useState(false);
  const [selectedNeighbourhoods, setSelectedNeighbourhoods] = useState<Set<string>>(new Set());
  const [focusedNeighbourhood, setFocusedNeighbourhood] = useState<{ id: string; name: string } | null>(null);
  const genIdxRef = useRef(0);

  // Refs for use inside map event callbacks (avoid stale closure)
  const drawModeRef = useRef<DrawMode>("normal");
  const selectedNeighbourhoodsRef = useRef<Set<string>>(new Set());
  // Blocks neighbourhood clicks for one tick after a polygon is completed,
  // preventing the closing double-click from immediately selecting a neighbourhood.
  const justCompletedBoundaryRef = useRef(false);

  useEffect(() => {
    drawModeRef.current = drawMode;
  }, [drawMode]);

  useEffect(() => {
    selectedNeighbourhoodsRef.current = selectedNeighbourhoods;
  }, [selectedNeighbourhoods]);

  function handleGenerate() {
    if (isGenerating) return;
    setIsGenerating(true);
    setSelectedRoute(null);
    setTimeout(() => {
      const route = GENERATED_ROUTES[genIdxRef.current % GENERATED_ROUTES.length]!;
      genIdxRef.current += 1;
      setGeneratedRoute(route);
      setDisabledStops(new Set());
      setIsGenerating(false);
    }, 1200);
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
        TORONTO_NEIGHBOURHOODS.features.forEach((f) => {
          const id = f.properties?.id as string;
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false });
        });
      }
      setSelectedNeighbourhoods(new Set());
      selectedNeighbourhoodsRef.current = new Set();
      draw.changeMode("draw_polygon");
    } else if (mode === "select") {
      // Clear any drawn boundary when entering neighbourhood-select mode
      draw.deleteAll();
      setHasBoundary(false);
      draw.changeMode("simple_select");
    } else {
      // "normal" — cancel any in-progress draw and return to view mode
      draw.changeMode("simple_select");
      // If we were mid-draw, the in-progress polygon is discarded by MapboxDraw
      // when switching away from draw_polygon mode.
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
      TORONTO_NEIGHBOURHOODS.features.forEach((f) => {
        const id = f.properties?.id as string;
        map.setFeatureState({ source: "neighbourhoods", id }, { selected: false });
      });
    }
    setSelectedNeighbourhoods(new Set());
    setDrawMode("normal");
    drawModeRef.current = "normal";
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

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: "mapbox://styles/mapbox/light-v11",
      center: TORONTO,
      zoom: 11.5,
      pitch: 40,
      bearing: -10,
      antialias: true,
    });

    mapRef.current = map;

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

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new mapboxgl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      const firstLabelLayer = map
        .getStyle()
        ?.layers?.find(
          (l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"],
        )?.id;

      // ── Neighbourhood fill/border layers (below routes)
      map.addSource("neighbourhoods", {
        type: "geojson",
        data: TORONTO_NEIGHBOURHOODS as GeoJSON.FeatureCollection,
        promoteId: "id",
      });

      map.addLayer(
        {
          id: "neighbourhood-fill",
          type: "fill",
          source: "neighbourhoods",
          paint: {
            "fill-color": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              "#6366f1",
              "#94a3b8",
            ],
            "fill-opacity": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              0.12,
              ["boolean", ["feature-state", "hovered"], false],
              0.06,
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
              ["boolean", ["feature-state", "selected"], false],
              "#6366f1",
              "#94a3b8",
            ],
            "line-width": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              1.5,
              0.5,
            ],
            "line-opacity": [
              "case",
              ["boolean", ["feature-state", "selected"], false],
              0.6,
              0.3,
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
        const id = e.features?.[0]?.properties?.id as string | undefined;
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
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (!id) return;
        const name = e.features?.[0]?.properties?.name as string | undefined;

        const current = selectedNeighbourhoodsRef.current;

        if (current.has(id)) {
          // Deselect this neighbourhood — clear the panel
          setFocusedNeighbourhood(null);
          map.setFeatureState({ source: "neighbourhoods", id }, { selected: false });
          setSelectedNeighbourhoods((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        } else {
          // Select — show panel for clicked neighbourhood
          setFocusedNeighbourhood({ id, name: name ?? id });
          // Find BFS path from existing selection → new target, select everything in between
          const toAdd = findNeighbourhoodPath(current, id);
          toAdd.forEach((nid) => {
            map.setFeatureState({ source: "neighbourhoods", id: nid }, { selected: true });
          });
          setSelectedNeighbourhoods((prev) => new Set([...prev, ...toAdd]));
        }

        // Stop propagation so route line clicks don't fire
        e.preventDefault();
      });

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

      // Population heatmap
      map.addSource("population", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: POPULATION_POINTS.map((p) => ({
            type: "Feature" as const,
            properties: { weight: p.weight },
            geometry: { type: "Point" as const, coordinates: p.coords },
          })),
        },
      });

      map.addLayer(
        {
          id: "population-heatmap",
          type: "heatmap",
          source: "population",
          paint: {
            "heatmap-weight": ["interpolate", ["linear"], ["get", "weight"], 0, 0, 1, 1],
            "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 15, 3],
            "heatmap-color": [
              "interpolate",
              ["linear"],
              ["heatmap-density"],
              0,   "rgba(0,0,255,0)",
              0.2, "rgba(33,102,172,0.4)",
              0.4, "rgba(103,169,207,0.6)",
              0.6, "rgba(253,219,99,0.75)",
              0.8, "rgba(239,138,98,0.85)",
              1,   "rgba(178,24,43,0.9)",
            ],
            "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 5, 20, 15, 70],
            "heatmap-opacity": 0.7,
          },
        },
        firstLabelLayer,
      );

      // Route lines + stops
      ROUTES.forEach((route) => {
        map.addSource(`route-${route.id}`, {
          type: "geojson",
          data: routeToGeoJSON(route),
        });

        map.addSource(`stops-${route.id}`, {
          type: "geojson",
          data: stopsToGeoJSON(route),
        });

        map.addLayer({
          id: `route-shadow-${route.id}`,
          type: "line",
          source: `route-${route.id}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": route.color,
            "line-width": 10,
            "line-opacity": 0.12,
            "line-blur": 4,
          },
        });

        map.addLayer({
          id: `route-line-${route.id}`,
          type: "line",
          source: `route-${route.id}`,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: { "line-color": route.color, "line-width": 4, "line-opacity": 1 },
        });

        map.addLayer({
          id: `stops-ring-${route.id}`,
          type: "circle",
          source: `stops-${route.id}`,
          minzoom: 11,
          paint: {
            "circle-radius": 6,
            "circle-color": route.color,
            "circle-opacity": 0.25,
            "circle-stroke-width": 0,
          },
        });

        map.addLayer({
          id: `stops-dot-${route.id}`,
          type: "circle",
          source: `stops-${route.id}`,
          minzoom: 11,
          paint: {
            "circle-radius": 3.5,
            "circle-color": "#ffffff",
            "circle-stroke-color": route.color,
            "circle-stroke-width": 2,
          },
        });

        map.on("click", `route-line-${route.id}`, () => setSelectedRoute(route));

        map.on("mouseenter", `route-line-${route.id}`, () => {
          map.getCanvas().style.cursor = "pointer";
          map.setPaintProperty(`route-line-${route.id}`, "line-width", 7);
          setHoveredId(route.id);
        });

        map.on("mouseleave", `route-line-${route.id}`, () => {
          map.getCanvas().style.cursor = "";
          map.setPaintProperty(`route-line-${route.id}`, "line-width", 4);
          setHoveredId(null);
        });
      });

      setMapLoaded(true);
    });

    // Escape cancels an in-progress boundary draw
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && drawModeRef.current === "boundary") {
        draw.deleteAll();
        draw.changeMode("simple_select");
        setHasBoundary(false);
        setDrawMode("normal");
        drawModeRef.current = "normal";
      }
    };
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── heatmap visibility toggle
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !map.getLayer("population-heatmap")) return;
    map.setLayoutProperty(
      "population-heatmap",
      "visibility",
      showHeatmap ? "visible" : "none",
    );
  }, [showHeatmap, mapLoaded]);

  // ── generated route layer (re-renders when route or stops change)
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    for (const id of ["generated-route-glow", "generated-route-line", "generated-stops-dot"]) {
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
          properties: { disabled: disabledStops.has(s.name) },
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
        "circle-color": ["case", ["==", ["get", "disabled"], true], "#d1d5db", "#ffffff"],
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

    map.on("click", "generated-route-line", () => setSelectedRoute(null));

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
  const hasSelection = hasBoundary || selectedNeighbourhoods.size > 0;

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* TTC Lines legend + neighbourhood panel — top left */}
      <div className="absolute top-5 left-5 flex flex-col gap-4">
        <div className="rounded-xl border border-[#D7D7D7] bg-white px-6 py-5 shadow-sm">
          <p className="mb-3 text-lg font-bold text-stone-800">
            TTC Lines
          </p>
          <ul className="space-y-2">
            {ROUTES.map((r) => (
              <li
                key={r.id}
                className="flex cursor-pointer items-center gap-3 text-base text-stone-600 hover:text-stone-900"
                onClick={() => setSelectedRoute(r)}
              >
                <span className="h-3 w-7 shrink-0 rounded-full" style={{ background: r.color }} />
                {r.name}
              </li>
            ))}
            {generatedRoute && (
              <>
                <li className="border-t border-stone-100 pt-1.5" />
                <li
                  className="flex cursor-pointer items-center gap-3 text-base text-stone-600 hover:text-stone-900"
                  onClick={() => setSelectedRoute(null)}
                >
                  <span
                    className="h-3 w-7 shrink-0 rounded-full border-2"
                    style={{ borderColor: generatedRoute.color, borderStyle: "dashed", background: "transparent" }}
                  />
                  <span className="truncate">{generatedRoute.name}</span>
                </li>
              </>
            )}
          </ul>
        </div>

        {focusedNeighbourhood && (
          <NeighbourhoodPanel
            id={focusedNeighbourhood.id}
            name={focusedNeighbourhood.name}
            onClose={() => setFocusedNeighbourhood(null)}
          />
        )}
      </div>

      {/* Top-center toolbar */}
      <div className="pointer-events-none absolute top-5 left-0 right-0 flex justify-center gap-2">
        {/* Heatmap toggle */}
        <button
          onClick={() => setShowHeatmap((v) => !v)}
          className={`pointer-events-auto flex h-[52px] items-center gap-3 rounded-xl border border-[#D7D7D7] bg-white px-6 text-base font-normal shadow-sm transition-all ${
            showHeatmap ? "text-stone-700" : "text-stone-400"
          }`}
        >
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ background: showHeatmap ? "#ef4444" : "#d1d5db" }}
          />
          Population Density
        </button>

        {/* Draw toolbar — wrapped in relative so the badge can anchor to it */}
        <div className="relative">
        <div className="pointer-events-auto flex h-[52px] items-center gap-1 rounded-xl border border-[#D7D7D7] bg-white px-2 shadow-sm">
          {/* Normal (default/view — no active tool) */}
          <button
            onClick={() => handleSetDrawMode("normal")}
            title="Normal"
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
              drawMode === "normal" ? "bg-stone-100 text-stone-900" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
            }`}
          >
            {/* Arrow cursor */}
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]">
              <path d="M4 1.5 L4 17 L8 13 L11 19 L13 18 L10 12 L16 12 Z" />
            </svg>
          </button>

          <div className="mx-1 h-6 w-px bg-stone-200" />

          {/* Select neighbourhoods */}
          <button
            onClick={() => handleSetDrawMode("select")}
            title="Select neighbourhoods"
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
              drawMode === "select" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
            }`}
          >
            {/* Cursor + dashed selection box — indicates click-to-select-region */}
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-[18px] w-[18px]">
              <path d="M2.5 1.5 L2.5 12.5 L5.5 9.5 L7.5 14 L9 13.3 L7 8.8 L11 8.8 Z" />
              <rect x="11.5" y="11" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="2 1.2" />
            </svg>
          </button>

          <div className="mx-1 h-6 w-px bg-stone-200" />

          {/* Polygon boundary */}
          <button
            onClick={() => handleSetDrawMode("boundary")}
            title="Draw boundary"
            className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
              drawMode === "boundary" ? "bg-indigo-50 text-indigo-600" : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
            }`}
          >
            {/* Dashed polygon with vertex dots */}
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" className="h-4 w-4">
              <polygon points="10,2 17,6.5 14.5,16 5.5,16 3,6.5" strokeWidth="1.6" strokeLinejoin="round" strokeDasharray="2.5 1.5" />
              <circle cx="10" cy="2" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="17" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="14.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="5.5" cy="16" r="1.4" fill="currentColor" stroke="none" />
              <circle cx="3" cy="6.5" r="1.4" fill="currentColor" stroke="none" />
            </svg>
          </button>

          {/* Clear button — visible when there's a drawn boundary or selected neighbourhoods */}
          {hasSelection && (
            <>
              <div className="mx-1 h-6 w-px bg-stone-200" />
              <button
                onClick={handleClearAll}
                title="Clear selection"
                className="flex h-9 w-9 items-center justify-center rounded-lg text-stone-400 transition-all hover:bg-red-50 hover:text-red-500"
              >
                <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                  <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 0 0 6 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 1 0 .23 1.482l.149-.022.841 10.518A2.75 2.75 0 0 0 7.596 19h4.807a2.75 2.75 0 0 0 2.742-2.53l.841-10.52.149.023a.75.75 0 0 0 .23-1.482A41.03 41.03 0 0 0 14 4.193v-.443A2.75 2.75 0 0 0 11.25 1h-2.5ZM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4ZM8.58 7.72a.75.75 0 0 0-1.5.06l.3 7.5a.75.75 0 1 0 1.5-.06l-.3-7.5Zm4.34.06a.75.75 0 1 0-1.5-.06l-.3 7.5a.75.75 0 1 0 1.5.06l.3-7.5Z" clipRule="evenodd" />
                </svg>
              </button>
            </>
          )}
        </div>

        {/* Drawing hint — shown while actively drawing a polygon */}
        {drawMode === "boundary" && (
          <div className="pointer-events-auto absolute top-0 left-full ml-2 flex h-[52px] items-center gap-3 whitespace-nowrap rounded-xl border border-stone-200 bg-white px-4 text-sm text-stone-500 shadow-sm">
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

        {/* Selection badge — absolutely anchored to the right of the toolbar, doesn't shift layout */}
        {selectedNeighbourhoods.size > 0 && (
          <div className="pointer-events-auto absolute top-0 left-full ml-2 flex h-[52px] items-center whitespace-nowrap rounded-xl border border-indigo-200 bg-indigo-50 px-4 text-sm font-medium text-indigo-700 shadow-sm">
            {selectedNeighbourhoods.size} neighbourhood{selectedNeighbourhoods.size !== 1 ? "s" : ""} selected
          </div>
        )}
        </div>
      </div>

      {/* Side panel — only one shown at a time to prevent overlap */}
      <div
        className={`pointer-events-none absolute top-10 right-9 bottom-10 flex items-stretch transition-transform duration-300 ease-in-out ${
          selectedRoute || showGeneratedPanel ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
      >
        {selectedRoute ? (
          <RoutePanel route={selectedRoute} onClose={() => setSelectedRoute(null)} />
        ) : showGeneratedPanel ? (
          <GeneratedRoutePanel
            route={generatedRoute}
            disabledStops={disabledStops}
            isGenerating={isGenerating}
            onToggleStop={handleToggleStop}
            onClose={() => setGeneratedRoute(null)}
            onRegenerate={handleGenerate}
          />
        ) : null}
      </div>

      {/* Generate Route — bottom centre, only visible when an area is selected */}
      {hasSelection && (
        <div className="pointer-events-none absolute bottom-16 left-0 right-0 flex justify-center">
          <button
            onClick={handleGenerate}
            disabled={isGenerating}
            className="pointer-events-auto flex h-[52px] items-center gap-3 rounded-xl bg-stone-900 px-8 text-base font-medium text-white shadow-lg transition-all hover:bg-stone-800 disabled:opacity-50"
          >
            <span className={`text-xl ${isGenerating ? "inline-block animate-spin" : ""}`}>✦</span>
            {isGenerating ? "Generating…" : "Generate Route"}
          </button>
        </div>
      )}
    </div>
  );
}
