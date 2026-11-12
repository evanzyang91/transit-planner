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
 *
 * Latency notes (2026-11): the slice is ~13k rows = 14 pages of 1000. Fetched
 * one after another that took 4–5 s on a cold server, before the first byte
 * of the user's answer. Pages are now fetched several at a time, the raster is
 * warmed at server start (instrumentation.ts), a failed fetch is not retried
 * on every request, and the network-coverage figure is memoized.
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
/** After a failed fetch, don't try again for this long (every request was retrying). */
const FAILURE_RETRY_MS = 30 * 1000;
const PAGE_SIZE = 1000;
const MAX_ROWS = 80_000; // safety valve so a surprise table size can't OOM the server
/** Pages in flight at once — fast, without flooding Supabase with requests. */
const PAGE_CONCURRENCY = 6;

let cache: RasterCache | null = null;
let inflight: Promise<RasterCache | null> | null = null;
let lastFailureAt = 0;

// ── Paging ────────────────────────────────────────────────────────────────────

export type PageResult<T> = { rows: T[]; error: null } | { rows: null; error: string };

/**
 * Fetch pages 0, 1, 2, … with up to `concurrency` requests in flight, until a
 * page comes back shorter than `pageSize` (the last one) or `maxPages` is hit.
 * Rows are returned in PAGE order no matter which request finished first.
 *
 * How: a small "worker pool" — each worker repeatedly takes the next page
 * number and fetches it. A short page tells everyone where the data ends, so
 * no new pages past it are started (a few already in flight just come back
 * empty and are ignored).
 *
 * 📖 Learn: bounded concurrency — Promise.all over ALL pages would fire every
 * request at once; a fixed number of workers caps the load on the database.
 */
export async function fetchAllPages<T>(
  fetchPage: (pageIndex: number) => Promise<PageResult<T>>,
  options: { pageSize: number; maxPages: number; concurrency: number },
): Promise<{ rows: T[]; error: string | null }> {
  const pages: T[][] = [];
  let nextPage = 0;
  let lastPage = options.maxPages - 1; // shrinks when a short page reveals the end
  let failure: string | null = null;

  async function worker(): Promise<void> {
    while (failure === null && nextPage <= lastPage) {
      const page = nextPage;
      nextPage += 1;
      let result: PageResult<T>;
      try {
        result = await fetchPage(page);
      } catch (err) {
        result = { rows: null, error: err instanceof Error ? err.message : String(err) };
      }
      if (result.error !== null) {
        failure = result.error;
        return;
      }
      pages[page] = result.rows;
      if (result.rows.length < options.pageSize) lastPage = Math.min(lastPage, page);
    }
  }

  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < options.concurrency; i++) workers.push(worker());
  await Promise.all(workers);

  if (failure !== null) return { rows: [], error: failure };
  const rows: T[] = [];
  for (let page = 0; page <= lastPage; page++) rows.push(...(pages[page] ?? []));
  return { rows, error: null };
}

async function fetchRasterPage(pageIndex: number): Promise<PageResult<CensusBlock>> {
  const [west, south, east, north] = TORONTO_BBOX;
  const from = pageIndex * PAGE_SIZE;
  const { data, error } = await supabase
    .from("pop_data")
    .select("longitude, latitude, population")
    .gte("latitude", south).lte("latitude", north)
    .gte("longitude", west).lte("longitude", east)
    .gt("population", 0)
    // An explicit order makes every page see the SAME row order. Without it,
    // pages fetched in parallel (or by a parallel database scan) could overlap
    // or skip rows — OFFSET paging is only well-defined on a sorted result.
    .order("latitude", { ascending: true })
    .order("longitude", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);

  if (error) return { rows: null, error: error.message };
  const rows = (data ?? []) as Array<{ longitude: number; latitude: number; population: number }>;
  return {
    rows: rows.map((r) => ({ coords: [r.longitude, r.latitude] as [number, number], population: r.population })),
    error: null,
  };
}

async function fetchRaster(): Promise<RasterCache | null> {
  const { rows: blocks, error } = await fetchAllPages(fetchRasterPage, {
    pageSize: PAGE_SIZE,
    maxPages: MAX_ROWS / PAGE_SIZE,
    concurrency: PAGE_CONCURRENCY,
  });
  if (error !== null) {
    console.warn("[map-data/census] pop_data fetch failed:", error);
    return null;
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
 * After an expired cache fails to refresh, the stale copy keeps being served.
 */
export async function getTorontoRaster(): Promise<RasterCache | null> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < TTL_MS) return cache;
  // Negative cache: a failure just happened — answer now (stale data or null)
  // instead of making every request wait for another doomed fetch.
  if (now - lastFailureAt < FAILURE_RETRY_MS) return cache;

  inflight ??= fetchRaster()
    .then((fresh) => {
      if (fresh) cache = fresh;
      else lastFailureAt = Date.now();
      return fresh;
    })
    .finally(() => {
      inflight = null;
    });
  await inflight;
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

// ── Network coverage (memoized) ───────────────────────────────────────────────

export interface NetworkCoverage {
  servedPopulation: number;
  totalPopulation: number;
  pct: number;
}

/**
 * A short id for "this set of stops". Two networks with the same stops (to
 * ~1 m) get the same id, so repeated questions on an unchanged map reuse the
 * coverage figure instead of re-scanning 13k census blocks (~60 ms) per turn.
 *
 * 📖 Learn: djb2 — a tiny, fast string hash (h = h × 33 + charCode). Not
 * cryptographic; a collision would only mean one stale coverage figure, and
 * the stop count in the key makes even that very unlikely.
 */
export function networkFingerprint(network: LiveNetwork): string {
  let hash = 5381;
  for (const stop of network.stops) {
    const text = `${stop.coords[0].toFixed(5)},${stop.coords[1].toFixed(5)};`;
    for (let i = 0; i < text.length; i++) {
      // `| 0` keeps the number a 32-bit integer so it never loses precision.
      hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    }
  }
  return `${network.stops.length}:${hash}`;
}

const COVERAGE_MEMO_MAX = 16;
const coverageMemo = new Map<string, { rasterFetchedAt: number; result: NetworkCoverage }>();

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
): Promise<NetworkCoverage | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null;

  const key = `${networkFingerprint(network)}|${walkKm}`;
  const remembered = coverageMemo.get(key);
  // Only valid for the raster it was computed from (refetched hourly).
  if (remembered?.rasterFetchedAt === raster.fetchedAt) return remembered.result;

  let served = 0;
  for (const block of raster.blocks) {
    // Nearest-stop lookup via the network's spatial grid — O(cells), not O(stops).
    if (network.grid.nearest(block.coords, walkKm)) served += block.population;
  }
  const pct = raster.totalPopulation > 0 ? (served / raster.totalPopulation) * 100 : 0;
  const result: NetworkCoverage = {
    servedPopulation: Math.round(served),
    totalPopulation: Math.round(raster.totalPopulation),
    pct: Math.round(pct * 10) / 10,
  };

  // Small and bounded: drop the oldest entry (a Map keeps insertion order).
  if (coverageMemo.size >= COVERAGE_MEMO_MAX) {
    const oldestKey = coverageMemo.keys().next().value;
    if (oldestKey !== undefined) coverageMemo.delete(oldestKey);
  }
  coverageMemo.set(key, { rasterFetchedAt: raster.fetchedAt, result });
  return result;
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
