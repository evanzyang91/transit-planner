//This hook manages the traffic overlay, one of the most important overlays

import { useEffect, useState } from "react";
//import type mapboxgl from "mapbox-gl"; available globally
import type { RefObject } from "react";

export function useTraffic(mapRef: RefObject<mapboxgl.Map | null>, mapLoaded: boolean) {

    const [trafficLoading, setTrafficLoading] = useState(true)
    const [showTraffic, setShowTraffic] = useState(false)
    const [trafficGeoJSON, setTrafficGeoJSON] = useState<GeoJSON.FeatureCollection | null>(null);
        
    useEffect(() => {
        // An AbortController (instead of a plain `cancelled` flag) actually STOPS
        // the download when this effect is cleaned up. In dev, React StrictMode
        // mounts → unmounts → re-mounts every component; with a flag, the
        // throwaway first mount still downloaded the full ~5.6 MB traffic JSON
        // and held a browser connection, so later requests queued behind it.
        // 📖 Learn: AbortController — https://developer.mozilla.org/en-US/docs/Web/API/AbortController
        // 📖 Learn: StrictMode double effects — https://react.dev/reference/react/StrictMode#fixing-bugs-found-by-re-running-effects-in-development
        const controller = new AbortController();
        setTrafficLoading(true);
        fetch("/api/traffic", { signal: controller.signal })
        .then((res) => res.json())
        .then((fc: GeoJSON.FeatureCollection) => {
            if (controller.signal.aborted) return;
            console.log("[traffic] API payload", {
            type: fc?.type,
            featureCount: fc?.features?.length ?? 0,
            firstFeature: fc?.features?.[0] ?? null,
            });
            setTrafficGeoJSON(fc);
            const map = mapRef.current;
            if (map && map.isStyleLoaded()) {
            const src = map.getSource("traffic") as mapboxgl.GeoJSONSource | undefined;
            if (src) {
                src.setData(fc);
                console.log("[traffic] setData from fetch", {
                hasSource: true,
                featureCount: fc?.features?.length ?? 0,
                layerExists: !!map.getLayer("traffic-lines"),
                layerVisibility: map.getLayer("traffic-lines")
                    ? map.getLayoutProperty("traffic-lines", "visibility")
                    : "missing",
                });
            } else {
                console.log("[traffic] source missing during fetch setData");
            }
            } else {
            console.log("[traffic] map/style not ready during fetch setData", {
                hasMap: !!map,
                styleLoaded: map ? map.isStyleLoaded() : false,
            });
            }
        })
        .catch((err: unknown) => {
            // Aborting rejects the fetch with an "AbortError". We caused that on
            // purpose (cleanup), so it isn't a failure worth logging.
            if (controller.signal.aborted) return;
            console.error("Failed to fetch traffic data:", err);
        })
        .finally(() => {
            // An aborted run must not flip loading off: under StrictMode the
            // second (real) mount's request is still in flight.
            if (!controller.signal.aborted) setTrafficLoading(false);
        });
        return () => controller.abort();
    }, []);

    

    // ── keep traffic source in sync; re-adds layer if wiped by style switch
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapLoaded || !trafficGeoJSON) return;
        const firstLabelLayer = map.getStyle()?.layers?.find((l) => l.type === "symbol" && (l.layout as Record<string, unknown>)?.["text-field"])?.id;
        if (!map.getSource("traffic")) {
        map.addSource("traffic", { type: "geojson", data: trafficGeoJSON });
        map.addLayer({ id: "traffic-lines", type: "line", source: "traffic", layout: { "line-join": "round", "line-cap": "round", visibility: showTraffic ? "visible" : "none" }, paint: { "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1.5, 14, 4], "line-color": ["case", ["!=", ["get", "avg_traffic"], null], ["match", ["get", "traffic_color"], "green", "#22c55e", "yellow", "#f59e0b", "red", "#ef4444", "#22c55e"], "#22c55e"], "line-opacity": 0.5 } }, firstLabelLayer);
        return;
        }
        (map.getSource("traffic") as mapboxgl.GeoJSONSource).setData(trafficGeoJSON);
    }, [trafficGeoJSON, mapLoaded]);



    // ── traffic lines visibility toggle
    useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (map.getLayer("traffic-lines")) {
        map.setLayoutProperty("traffic-lines", "visibility", showTraffic ? "visible" : "none");
        console.log("[traffic] toggle visibility", {
        showTraffic,
        appliedVisibility: map.getLayoutProperty("traffic-lines", "visibility"),
        hasSource: !!map.getSource("traffic"),
        sourceFeatureCount: trafficGeoJSON?.features?.length ?? 0,
        });
    } else {
        console.log("[traffic] toggle attempted but layer missing", { showTraffic });
    }
    }, [showTraffic, mapLoaded, trafficGeoJSON]);


    return {
        showTraffic,
        trafficLoading,
        trafficGeoJSON,
        setShowTraffic,
    }
}

