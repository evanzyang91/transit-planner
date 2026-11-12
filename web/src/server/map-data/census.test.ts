import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { networkStats } from "~/lib/network-stats";
import { SpatialGrid } from "./spatial-grid";
import type { LiveNetwork, NetStop } from "./network";

/**
 * census.ts latency work: pages fetched several at a time (in page order), a
 * short negative cache after a failure, and a memo for network coverage.
 * Supabase is replaced by a fake query builder whose `.range()` answers from
 * `supabaseFake.page` — no network.
 */
const supabaseFake = vi.hoisted(() => ({
  page: async (_from: number): Promise<{ data: unknown[] | null; error: { message: string } | null }> => ({
    data: [],
    error: null,
  }),
  calls: 0,
}));

vi.mock("../supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "gte", "lte", "gt", "order"]) builder[method] = () => builder;
  builder.range = (from: number) => {
    supabaseFake.calls += 1;
    return supabaseFake.page(from);
  };
  return { supabase: { from: () => builder } };
});

/** A fresh copy of census.ts (its caches are module state). */
async function freshCensus() {
  vi.resetModules();
  return import("./census");
}

function makeNetwork(stopCoords: Array<[number, number]>): LiveNetwork {
  const routes = [{ id: "r", name: "Route", type: "subway", stops: stopCoords.map((coords, i) => ({ name: `S${i}`, coords })) }];
  const stops: NetStop[] = routes[0]!.stops.map((s) => ({ name: s.name, route: "Route", routeType: "subway", coords: s.coords }));
  return { routes, stops, grid: new SpatialGrid(stops, 1), stats: networkStats(routes) };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  supabaseFake.calls = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fetchAllPages", () => {
  it("returns rows in PAGE order even when later pages arrive first", async () => {
    const { fetchAllPages } = await freshCensus();
    const { rows, error } = await fetchAllPages(
      async (page) => {
        await sleep(20 - page * 4); // page 4 is fastest
        const size = page < 4 ? 2 : 1; // page 4 is the short, last one
        return { rows: Array.from({ length: size }, (_, i) => `p${page}-${i}`), error: null };
      },
      { pageSize: 2, maxPages: 50, concurrency: 6 },
    );
    expect(error).toBeNull();
    expect(rows).toEqual(["p0-0", "p0-1", "p1-0", "p1-1", "p2-0", "p2-1", "p3-0", "p3-1", "p4-0"]);
  });

  it("never has more than `concurrency` pages in flight", async () => {
    const { fetchAllPages } = await freshCensus();
    let inFlight = 0;
    let maxInFlight = 0;
    await fetchAllPages(
      async (page) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await sleep(2);
        inFlight -= 1;
        return { rows: page < 13 ? [1, 2] : [1], error: null };
      },
      { pageSize: 2, maxPages: 80, concurrency: 6 },
    );
    expect(maxInFlight).toBe(6);
  });

  it("stops starting pages once a short page shows where the data ends", async () => {
    const { fetchAllPages } = await freshCensus();
    const requested: number[] = [];
    const { rows } = await fetchAllPages(
      async (page) => {
        requested.push(page);
        await sleep(5);
        // Data ends at page 2 (short); later pages are empty.
        if (page < 2) return { rows: ["a", "b"], error: null };
        if (page === 2) return { rows: ["c"], error: null };
        return { rows: [], error: null };
      },
      { pageSize: 2, maxPages: 80, concurrency: 3 },
    );
    expect(rows).toEqual(["a", "b", "a", "b", "c"]);
    // At most (concurrency − 1) pages past the end were started before it was known.
    expect(requested.length).toBeLessThanOrEqual(3 + 2);
  });

  it("caps the number of pages (the MAX_ROWS safety valve)", async () => {
    const { fetchAllPages } = await freshCensus();
    const { rows } = await fetchAllPages(async () => ({ rows: [1, 1], error: null }), {
      pageSize: 2,
      maxPages: 5,
      concurrency: 3,
    });
    expect(rows).toHaveLength(10);
  });

  it("reports the first error (thrown or returned)", async () => {
    const { fetchAllPages } = await freshCensus();
    const returned = await fetchAllPages(
      async (page) => (page === 1 ? { rows: null, error: "permission denied" } : { rows: [1, 1], error: null }),
      { pageSize: 2, maxPages: 10, concurrency: 2 },
    );
    expect(returned).toEqual({ rows: [], error: "permission denied" });

    const thrown = await fetchAllPages(
      async () => {
        throw new Error("fetch failed");
      },
      { pageSize: 2, maxPages: 10, concurrency: 2 },
    );
    expect(thrown).toEqual({ rows: [], error: "fetch failed" });
  });
});

describe("networkFingerprint", () => {
  it("is equal for the same stops and different when a stop moves or is added", async () => {
    const { networkFingerprint } = await freshCensus();
    const a = makeNetwork([[-79.38, 43.65], [-79.4, 43.7]]);
    const b = makeNetwork([[-79.38, 43.65], [-79.4, 43.7]]);
    const moved = makeNetwork([[-79.38, 43.65], [-79.41, 43.7]]);
    const added = makeNetwork([[-79.38, 43.65], [-79.4, 43.7], [-79.3, 43.8]]);
    expect(networkFingerprint(a)).toBe(networkFingerprint(b));
    expect(networkFingerprint(a)).not.toBe(networkFingerprint(moved));
    expect(networkFingerprint(a)).not.toBe(networkFingerprint(added));
  });
});

describe("getTorontoRaster", () => {
  const ROWS = [
    { longitude: -79.38, latitude: 43.65, population: 1000 },
    { longitude: -79.5, latitude: 43.75, population: 500 },
  ];

  it("doesn't retry a failed fetch for 30 s (negative cache), then tries again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T12:00:00Z"));
    const census = await freshCensus();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    supabaseFake.page = async () => ({ data: null, error: { message: "timeout" } });
    expect(await census.getTorontoRaster()).toBeNull();
    const callsAfterFailure = supabaseFake.calls;

    expect(await census.getTorontoRaster()).toBeNull();
    expect(supabaseFake.calls).toBe(callsAfterFailure); // no new requests

    vi.setSystemTime(new Date("2026-11-12T12:00:31Z"));
    supabaseFake.page = async (from) => ({ data: from === 0 ? ROWS : [], error: null });
    const raster = await census.getTorontoRaster();
    expect(raster?.blocks).toHaveLength(2);
    expect(raster?.totalPopulation).toBe(1500);
    warn.mockRestore();
  });

  it("de-duplicates concurrent cold-start fetches", async () => {
    const census = await freshCensus();
    supabaseFake.page = async (from) => {
      await sleep(5);
      return { data: from === 0 ? ROWS : [], error: null };
    };
    const [a, b] = await Promise.all([census.getTorontoRaster(), census.getTorontoRaster()]);
    expect(a).toBe(b);
    expect(supabaseFake.calls).toBeLessThanOrEqual(6); // one fetch's worth of pages, not two
  });
});

describe("populationServedByNetwork", () => {
  it("memoizes by network fingerprint and walk distance", async () => {
    const census = await freshCensus();
    supabaseFake.page = async (from) => ({
      data:
        from === 0
          ? [
              { longitude: -79.38, latitude: 43.65, population: 1000 }, // next to the stop
              { longitude: -79.2, latitude: 43.8, population: 500 }, // far away
            ]
          : [],
      error: null,
    });

    const first = makeNetwork([[-79.381, 43.651]]);
    const sameStops = makeNetwork([[-79.381, 43.651]]);
    const nearestFirst = vi.spyOn(first.grid, "nearest");
    const nearestSame = vi.spyOn(sameStops.grid, "nearest");

    const coverage = await census.populationServedByNetwork(first);
    expect(coverage).toEqual({ servedPopulation: 1000, totalPopulation: 1500, pct: 66.7 });
    expect(nearestFirst).toHaveBeenCalled();

    // A new request with the same map: answered from the memo, no scan.
    expect(await census.populationServedByNetwork(sameStops)).toEqual(coverage);
    expect(nearestSame).not.toHaveBeenCalled();

    // A different walking distance is a different question.
    await census.populationServedByNetwork(sameStops, 0.2);
    expect(nearestSame).toHaveBeenCalled();
  });
});
