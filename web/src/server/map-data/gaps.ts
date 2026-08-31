import "server-only";

/**
 * Raster service-level engine: ranks POCKETS of census population by how well
 * the current network serves them — in either direction. One flexible,
 * parameterized tool feeds both "where are the gaps?" and "where is coverage
 * strongest?" (and whatever comes next) instead of one bespoke tool per
 * question: the model reasons over ranked data, the server owns the geometry.
 *
 * Output is a list of ARTIFACTS with ids. The model never receives or invents
 * polygon coordinates: it cites an artifact id (show_area) and the server
 * resolves the geometry.
 */

import { POPULATION_CENTERS } from "~/app/map/population-centers";
import { haversineKm } from "~/app/map/geo-utils";
import { cellUnionOutline, inBBox, type BBox } from "./geo";
import { cityNeighbourhoodAt } from "./city-neighbourhoods";
import { districtAt } from "./districts";
import { getTorontoRaster, type CensusBlock } from "./census";
import type { LiveNetwork } from "./network";

export type RankOrder = "least_served" | "best_served";

export interface AreaArtifact {
  id: string;
  kind: "gap" | "served";
  /** Human name: neighbourhood, else former borough, else nearest pop centre. */
  name: string;
  population: number;
  /** Distance from the pocket's seed (its most extreme block) to the nearest stop. */
  seedStopKm: number;
  nearestStop: string | null;
  /** Stops inside the pocket's bbox (only meaningful for best_served). */
  stopsInside: number;
  centroid: [number, number];
  bbox: BBox;
  /** Server-computed outline: the smoothed union of the member census cells. */
  polygon: [number, number][];
}

// A block is "unserved" beyond this nearest-stop distance (callers may override).
export const DEFAULT_GAP_THRESHOLD_KM = 1.0;
// Ignore pockets below this population — not worth drawing.
const MIN_AREA_POPULATION = 2000;
// Each area is a POCKET: blocks within this radius of the worst/best seed block.
// Bounding the radius keeps every area focused and actionable — on a sparse
// network, connected-component clustering would fuse half the city into one
// giant unactionable "gap" (observed live: a 2.8M-person polygon).
const POCKET_RADIUS_KM = 2.5;
// Cap the nearest-stop search; beyond this we just report ">SEARCH_CAP km".
const SEARCH_CAP_KM = 6;
const MAX_AREAS = 12;
// Safety bound on pocket extraction (skipped low-pop pockets also consume blocks).
const MAX_POCKET_ITERATIONS = 80;

// ── tiny result cache ─────────────────────────────────────────────────────────
// Ranking is O(raster); the same network is often queried repeatedly within
// one conversation. Key on a cheap fingerprint of the stops + parameters.
const areaCache = new Map<string, { at: number; areas: AreaArtifact[] }>();
const AREA_CACHE_TTL_MS = 5 * 60 * 1000;
const AREA_CACHE_MAX = 8;

function networkFingerprint(
  network: LiveNetwork,
  order: RankOrder,
  thresholdKm: number,
  bbox?: BBox,
): string {
  // djb2 over rounded stop coords — collisions are astronomically unlikely to
  // matter here (worst case: a stale-but-plausible ranking for 5 minutes).
  let h = 5381;
  for (const s of network.stops) {
    const str = s.coords[0].toFixed(4) + "," + s.coords[1].toFixed(4);
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return `${h}:${order}:${thresholdKm}:${bbox ? bbox.join(",") : "all"}`;
}

function areaName(point: [number, number]): string {
  // Official City of Toronto neighbourhood (158, city-wide) — the precise name.
  const hood = cityNeighbourhoodAt(point[0], point[1]);
  const district = districtAt(point[0], point[1]);
  // "L'Amoreaux West (Scarborough)" reads better than either name alone.
  if (hood) return district ? `${hood} (${district})` : hood;
  // District beats "nearest municipality": a Scarborough pocket used to be
  // named "Markham area" because only GTA municipalities were catalogued.
  if (district) return district;
  let best: { name: string; km: number } | null = null;
  for (const c of POPULATION_CENTERS) {
    const km = haversineKm(point, [c.lng, c.lat]);
    if (!best || km < best.km) best = { name: c.name, km };
  }
  return best ? `${best.name} area` : "Unnamed area";
}

// Cheap planar distance for the pocket-radius check (equirectangular approx —
// fine at city scale; haversine would be ~4× the cost for no visible change).
const KM_LAT = 110.574;
const KM_LNG = 111.32 * Math.cos((43.7 * Math.PI) / 180);
function fastKm(a: [number, number], b: [number, number]): number {
  const dx = (a[0] - b[0]) * KM_LNG;
  const dy = (a[1] - b[1]) * KM_LAT;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Rank service pockets of the live network.
 *
 * order = "least_served": pockets of blocks farther than `thresholdKm` from
 * every stop, worst epicentre first (ids gap_1, gap_2, …).
 * order = "best_served": pockets of blocks within `thresholdKm` of a stop,
 * most people × closest service first (ids served_1, served_2, …).
 *
 * Returns [] when census data is unavailable — callers must say so rather
 * than let the model guess.
 */
export async function rankServiceAreas(
  network: LiveNetwork,
  order: RankOrder,
  thresholdKm = DEFAULT_GAP_THRESHOLD_KM,
  bbox?: BBox,
): Promise<AreaArtifact[]> {
  const key = networkFingerprint(network, order, thresholdKm, bbox);
  const hit = areaCache.get(key);
  if (hit && Date.now() - hit.at < AREA_CACHE_TTL_MS) return hit.areas;

  const raster = await getTorontoRaster();
  if (!raster) return [];

  // 1. Partition blocks by the serve threshold; keep only the side we rank.
  const candidates: Array<{ block: CensusBlock; nearestKm: number }> = [];
  for (const block of raster.blocks) {
    if (bbox && !inBBox(block.coords[0], block.coords[1], bbox)) continue;
    const near = network.grid.nearest(block.coords, SEARCH_CAP_KM);
    const km = near ? near.km : SEARCH_CAP_KM;
    if (order === "least_served" ? km > thresholdKm : km <= thresholdKm) {
      candidates.push({ block, nearestKm: km });
    }
  }
  if (candidates.length === 0) {
    areaCache.set(key, { at: Date.now(), areas: [] });
    return [];
  }

  // 2. Extract SEEDED POCKETS, most extreme first. 📖 Learn: greedy "peak
  // extraction" (like non-maximum suppression in vision): take the most severe
  // remaining block as a seed, claim everything within POCKET_RADIUS_KM of it
  // as one area, repeat on what's left. Every area is therefore ≤ ~5 km across
  // and ranked by its epicentre.
  //   least_served severity: many people, far from stops  → pop × distance
  //   best_served  severity: many people, close to stops  → pop ÷ distance
  const severity = (u: { block: CensusBlock; nearestKm: number }) =>
    order === "least_served"
      ? u.block.population * u.nearestKm
      : u.block.population / (u.nearestKm + 0.2);

  const pool = [...candidates].sort((a, b) => severity(b) - severity(a));
  const claimed = new Array<boolean>(pool.length).fill(false);
  const areas: AreaArtifact[] = [];

  let cursor = 0;
  for (let iter = 0; iter < MAX_POCKET_ITERATIONS && areas.length < MAX_AREAS; iter++) {
    while (cursor < pool.length && claimed[cursor]) cursor++;
    if (cursor >= pool.length) break;
    const seed = pool[cursor]!;

    let pop = 0;
    let cx = 0;
    let cy = 0;
    const points: [number, number][] = [];
    for (let i = cursor; i < pool.length; i++) {
      if (claimed[i]) continue;
      const u = pool[i]!;
      if (fastKm(seed.block.coords, u.block.coords) > POCKET_RADIUS_KM) continue;
      claimed[i] = true;
      pop += u.block.population;
      // Population-weighted centroid: the area's "centre" is where the people are.
      cx += u.block.coords[0] * u.block.population;
      cy += u.block.coords[1] * u.block.population;
      points.push(u.block.coords);
    }
    if (pop < MIN_AREA_POPULATION) continue; // too small to draw; blocks stay claimed
    const centroid: [number, number] = [cx / pop, cy / pop];

    // Outline the cells the people are actually in, not a hull spanning them.
    let polygon = cellUnionOutline(points);
    if (polygon.length < 3) {
      // Degenerate pocket (1–2 blocks): draw a small diamond so it's visible.
      const d = 0.004; // ~350 m
      const [lng, lat] = centroid;
      polygon = [[lng, lat + d], [lng + d, lat], [lng, lat - d], [lng - d, lat]];
    }
    const lngs = polygon.map((p) => p[0]);
    const lats = polygon.map((p) => p[1]);
    const areaBBox: BBox = [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];

    areas.push({
      id: "", // assigned after sorting so *_1 is always the top-ranked area
      kind: order === "least_served" ? "gap" : "served",
      // Named at the SEED (the single most extreme block) — that's the point
      // planners should look at, and centroid naming mislabels off-centre pockets.
      name: areaName(seed.block.coords),
      population: Math.round(pop),
      seedStopKm: Math.round(seed.nearestKm * 100) / 100,
      nearestStop: network.grid.nearest(seed.block.coords, SEARCH_CAP_KM)?.item.name ?? null,
      stopsInside: network.stops.filter((s) => inBBox(s.coords[0], s.coords[1], areaBBox)).length,
      centroid: [Math.round(centroid[0] * 1e5) / 1e5, Math.round(centroid[1] * 1e5) / 1e5],
      bbox: areaBBox,
      polygon,
    });
  }

  areas.sort((a, b) => b.population - a.population);
  const prefix = order === "least_served" ? "gap" : "served";
  const top = areas.map((g, i) => ({ ...g, id: `${prefix}_${i + 1}` }));

  if (areaCache.size >= AREA_CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order).
    const oldest = areaCache.keys().next().value;
    if (oldest !== undefined) areaCache.delete(oldest);
  }
  areaCache.set(key, { at: Date.now(), areas: top });
  return top;
}
