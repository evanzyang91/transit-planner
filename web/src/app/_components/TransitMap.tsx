"use client";

import mapboxgl from "mapbox-gl";
import { useEffect, useRef, useState } from "react";
import {
  GENERATED_ROUTES,
  POPULATION_POINTS,
  ROUTES,
  type GeneratedRoute,
  type Route,
} from "~/app/map/mock-data";

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
  const [selectedRoute, setSelectedRoute] = useState<Route | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [generatedRoute, setGeneratedRoute] = useState<GeneratedRoute | null>(null);
  const [disabledStops, setDisabledStops] = useState<Set<string>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [showHeatmap, setShowHeatmap] = useState(true);
  const [mapLoaded, setMapLoaded] = useState(false);
  const genIdxRef = useRef(0);

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

    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new mapboxgl.ScaleControl({ unit: "metric" }), "bottom-left");

    map.on("load", () => {
      const firstLabelLayer = map
        .getStyle()
        ?.layers?.find(
          (l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"],
        )?.id;

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

    return () => {
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

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />

      {/* TTC Lines legend — top left */}
      <div className="absolute top-5 left-5 rounded-2xl border border-[#D7D7D7] bg-white px-6 py-5 shadow-sm">
        <p className="mb-3 text-base font-bold text-stone-800">
          TTC Lines
        </p>
        <ul className="space-y-2">
          {ROUTES.map((r) => (
            <li
              key={r.id}
              className="flex cursor-pointer items-center gap-3 text-sm text-stone-600 hover:text-stone-900"
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
                className="flex cursor-pointer items-center gap-3 text-sm text-stone-600 hover:text-stone-900"
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

      {/* Center controls */}
      <div className="pointer-events-none absolute top-5 left-0 right-0 flex justify-center gap-4">
        {/* Heatmap toggle */}
        <button
          onClick={() => setShowHeatmap((v) => !v)}
          className={`pointer-events-auto flex h-[52px] items-center gap-3 rounded-full border border-[#D7D7D7] bg-white px-6 text-sm font-normal shadow-sm transition-all ${
            showHeatmap ? "text-stone-700" : "text-stone-400"
          }`}
        >
          <span
            className="h-3 w-3 shrink-0 rounded-full"
            style={{ background: showHeatmap ? "#ef4444" : "#d1d5db" }}
          />
          Population Density
        </button>

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={isGenerating}
          className="pointer-events-auto flex h-[52px] w-[52px] items-center justify-center rounded-full border border-[#D7D7D7] bg-white text-lg shadow-sm transition-all hover:bg-stone-50 disabled:opacity-50"
          title="Generate New Line"
        >
          <span className={isGenerating ? "inline-block animate-spin" : ""}>✦</span>
        </button>
      </div>

      {/* TTC route panel */}
      <div
        className={`pointer-events-none absolute top-10 right-9 bottom-10 flex items-stretch transition-transform duration-300 ease-in-out ${
          selectedRoute ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
      >
        {selectedRoute && (
          <RoutePanel route={selectedRoute} onClose={() => setSelectedRoute(null)} />
        )}
      </div>

      {/* Generated route stats panel */}
      <div
        className={`pointer-events-none absolute top-10 right-9 bottom-10 flex items-stretch transition-transform duration-300 ease-in-out ${
          showGeneratedPanel ? "translate-x-0" : "translate-x-[calc(100%+2.25rem)]"
        }`}
      >
        {showGeneratedPanel && (
          <GeneratedRoutePanel
            route={generatedRoute}
            disabledStops={disabledStops}
            isGenerating={isGenerating}
            onToggleStop={handleToggleStop}
            onClose={() => setGeneratedRoute(null)}
            onRegenerate={handleGenerate}
          />
        )}
      </div>

    </div>
  );
}
