import { useEffect, useState } from "react";
//import type mapboxgl from "mapbox-gl"; available globally
import type { RefObject } from "react";
import { type PopRow } from "~/app/map/geo-utils";


export function useHeatmap(mapRef: RefObject<mapboxgl.Map | null>, mapLoaded: boolean) {
    const [showHeatmap, setShowHeatmap] = useState(false);
    const [populationGeoJSON, setPopulationGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
    const [popLoading, setPopLoading] = useState(true);
    const [popRawData, setPopRawData] = useState<PopRow[]>([]);
    

    // ── fetch population data from Supabase via API
    useEffect(() => {
        // An AbortController (instead of a plain `cancelled` flag) actually STOPS
        // the download when this effect is cleaned up. That matters in dev, where
        // React StrictMode mounts → unmounts → re-mounts every component: with a
        // flag, the throwaway first mount still downloaded the whole ~1 MB
        // response and held a browser connection, so requests piled up.
        // 📖 Learn: AbortController — https://developer.mozilla.org/en-US/docs/Web/API/AbortController
        // 📖 Learn: StrictMode double effects — https://react.dev/reference/react/StrictMode#fixing-bugs-found-by-re-running-effects-in-development
        const controller = new AbortController();
        fetch("/api/population", { signal: controller.signal })
        .then((res) => res.json())
        .then((rows: { latitude: number; longitude: number; population: number; area: number }[]) => {
            if (controller.signal.aborted) return;
            if (!Array.isArray(rows)) return;
            // Compute population density (pop/area), then log-normalize to 0–1
            // Log scale is essential because density spans several orders of magnitude
            const densities = rows.map((r) => (r.area > 0 ? r.population / r.area : 0));
            const logDensities = densities.map((d) => (d > 0 ? Math.log1p(d) : 0));
            const maxLog = Math.max(1, ...logDensities);

            const features: GeoJSON.Feature<GeoJSON.Point>[] = rows.map((r, i) => ({
            type: "Feature",
            properties: {
                weight: logDensities[i]! / maxLog,
                density: densities[i]!,
            },
            geometry: { type: "Point", coordinates: [r.longitude, r.latitude] },
            }));

            const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
            setPopulationGeoJSON(fc);
            setPopRawData(rows);

            // Update the map source if it already exists
            const map = mapRef.current;
            if (map) {
            const src = map.getSource("population") as mapboxgl.GeoJSONSource | undefined;
            if (src) src.setData(fc);
            }
        })
        .catch((err: unknown) => {
            // Aborting rejects the fetch with an "AbortError". We caused that on
            // purpose (cleanup), so it isn't a failure worth logging.
            if (controller.signal.aborted) return;
            console.error("Failed to fetch population data:", err);
        })
        .finally(() => {
            // An aborted run must not flip loading off: under StrictMode the
            // second (real) mount's request is still in flight.
            if (!controller.signal.aborted) setPopLoading(false);
        });
        return () => controller.abort();
    }, []);


    // ── population visibility toggle (heatmap + points)
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded) return;
        const vis = showHeatmap ? "visible" : "none";
        if (map.getLayer("population-heatmap")) {
        map.setLayoutProperty("population-heatmap", "visibility", vis);
        }
        if (map.getLayer("population-points")) {
        map.setLayoutProperty("population-points", "visibility", vis);
        }
    }, [showHeatmap, mapLoaded]);

      // ── keep population source in sync; re-adds layers if wiped by style switch
      useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded || !populationGeoJSON) return;
        const firstLabelLayer = map.getStyle()?.layers?.find((l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"])?.id;
        if (!map.getSource("population")) {
          map.addSource("population", { type: "geojson", data: populationGeoJSON });
          map.addLayer({ id: "population-heatmap", type: "heatmap", source: "population", paint: { "heatmap-weight": ["interpolate", ["linear"], ["get", "weight"], 0, 0, 1, 1], "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 10, 0.4, 13, 0.8], "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 10, 10, 12, 28, 13, 50], "heatmap-color": ["interpolate", ["linear"], ["heatmap-density"], 0, "rgba(0,0,0,0)", 0.2, "rgba(0,104,55,0.15)", 0.4, "rgba(102,189,99,0.5)", 0.6, "rgba(255,255,51,0.8)", 0.8, "rgba(253,141,60,0.9)", 1, "rgba(215,25,28,1)"], "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 9, 0, 10, 0.75, 13, 0.3, 15, 0] } }, firstLabelLayer);
          map.addLayer({ id: "population-points", type: "circle", source: "population", minzoom: 12, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 15, 2, 17, 4, 19, 8], "circle-color": ["interpolate", ["linear"], ["get", "weight"], 0, "rgb(0,104,55)", 0.3, "rgb(102,189,99)", 0.5, "rgb(255,255,51)", 0.7, "rgb(253,141,60)", 0.85, "rgb(253,141,60)", 1, "rgb(215,25,28)"], "circle-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 17, 0.75], "circle-stroke-width": 0.5, "circle-stroke-color": "rgba(255,255,255,0.5)" } }, firstLabelLayer);
          return; // data already set via addSource
        }
        (map.getSource("population") as mapboxgl.GeoJSONSource).setData(populationGeoJSON);
      }, [populationGeoJSON, mapLoaded]);
    


    return {
        showHeatmap,
        popLoading,
        setShowHeatmap,
        popRawData
    }
}