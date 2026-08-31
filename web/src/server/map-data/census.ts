import "server-only";

/**
 * Cached Toronto census raster — the ONE gateway to `pop_data` for AI tools.
 *
 * Why a cache: the council tools query Supabase per tool call (fine at ~5
 * calls/run), but the gap engine needs *every* Toronto block at once, and the
 * assistant may ask several population questions per turn. We fetch the
 * Toronto-bbox slice once and keep it in memory with a TTL.
 *
 * Why NOT population.ts's fetchPopulationData(): that pages the entire
 * Canada-wide table. We clip to TORONTO_BBOX in SQL (index-friendly range
 * filters) and cap the row count as a safety valve.
 */

import { supabase } from "../supabase";
import { TORONTO_BBOX } from "./geo";
import { SpatialGrid } from "./spatial-grid";
import type { LiveNetwork } from "./network";

export interface CensusBlock {
  coords: [number, number]; // [lng, lat]
  population: number;
}

interface RasterCache {
  blocks: CensusBlock[];
  grid: SpatialGrid<CensusBlock>;
  totalPopulation: number;
  fetchedAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 h — census data changes never, server memory is finite
const PAGE_SIZE = 1000;
const MAX_ROWS = 80_000; // safety valve so a surprise table size can't OOM the server

let cache: RasterCache | null = null;
let inflight: Promise<RasterCache | null> | null = null;

async function fetchRaster(): Promise<RasterCache | null> {
  const [west, south, east, north] = TORONTO_BBOX;
  const blocks: CensusBlock[] = [];
  let offset = 0;

  while (blocks.length < MAX_ROWS) {
    const { data, error } = await supabase
      .from("pop_data")
      .select("longitude, latitude, population")
      .gte("latitude", south).lte("latitude", north)
      .gte("longitude", west).lte("longitude", east)
      .gt("population", 0)
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.warn("[map-data/census] pop_data fetch failed:", error.message);
      return null;
    }
    if (!data || data.length === 0) break;
    for (const r of data as Array<{ longitude: number; latitude: number; population: number }>) {
      blocks.push({ coords: [r.longitude, r.latitude], population: r.population });
    }
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  if (blocks.length === 0) return null;
  return {
    blocks,
    // 0.5 km cells: population queries are usually sub-2 km radius.
    grid: new SpatialGrid(blocks, 0.5),
    totalPopulation: blocks.reduce((s, b) => s + b.population, 0),
    fetchedAt: Date.now(),
  };
}

/**
 * The cached raster, or null when Supabase is unavailable — callers must
 * degrade gracefully (tools report "population data unavailable", never guess).
 * The `inflight` promise de-duplicates concurrent cold-start fetches.
 */
export async function getTorontoRaster(): Promise<RasterCache | null> {
  if (cache && Date.now() - cache.fetchedAt < TTL_MS) return cache;
  inflight ??= fetchRaster().finally(() => { inflight = null; });
  const fresh = await inflight;
  if (fresh) cache = fresh;
  return cache;
}

/** Total census population within `radiusKm` of a point. */
export async function populationInRadius(
  point: [number, number],
  radiusKm: number,
): Promise<{ population: number; blockCount: number } | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null;
  const blocks = raster.grid.within(point, radiusKm);
  return {
    population: Math.round(blocks.reduce((s, b) => s + b.population, 0)),
    blockCount: blocks.length,
  };
}

/** The `n` most populous census blocks within `radiusKm` of a point. */
export async function densestBlocks(
  point: [number, number],
  radiusKm: number,
  n = 8,
): Promise<Array<{ coords: [number, number]; population: number }> | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null;
  return raster.grid
    .within(point, radiusKm)
    .sort((a, b) => b.population - a.population)
    .slice(0, n)
    .map((b) => ({ coords: b.coords, population: Math.round(b.population) }));
}

/**
 * Share of the Toronto census population within walking distance of ANY stop
 * in the network. Each block is counted at most once (a UNION, not a
 * per-station sum — computeStationPopulations in geo-utils intentionally
 * double-counts blocks per station; that's the wrong semantics for "how much
 * of the city does my network reach").
 */
export async function populationServedByNetwork(
  network: LiveNetwork,
  walkKm = 0.8,
): Promise<{ servedPopulation: number; totalPopulation: number; pct: number } | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null;
  let served = 0;
  for (const block of raster.blocks) {
    // Nearest-stop lookup via the network's spatial grid — O(cells), not O(stops).
    if (network.grid.nearest(block.coords, walkKm)) served += block.population;
  }
  const pct = raster.totalPopulation > 0 ? (served / raster.totalPopulation) * 100 : 0;
  return {
    servedPopulation: Math.round(served),
    totalPopulation: Math.round(raster.totalPopulation),
    pct: Math.round(pct * 10) / 10,
  };
}

/** Walk-shed population around one candidate stop (for the ridership model). */
export async function catchmentPopulation(
  stop: [number, number],
  walkRadiusKm: number,
): Promise<number | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null;
  // grid.within already applies the exact circular distance test.
  return Math.round(
    raster.grid.within(stop, walkRadiusKm).reduce((s, b) => s + b.population, 0),
  );
}
