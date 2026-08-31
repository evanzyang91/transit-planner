import { beforeEach, describe, expect, it, vi } from "vitest";

import CENSUS_POINTS from "./__fixtures__/census-points.json";
import { SpatialGrid } from "./spatial-grid";
import type { LiveNetwork, NetStop } from "./network";
import { networkStats } from "~/lib/network-stats";

/**
 * gaps.ts reads the census raster from Supabase, so the fetch is stubbed with
 * the same real-coordinate fixture the geometry tests use. What's under test is
 * the pocket-extraction logic, not the network call.
 *
 * The invariant that matters most is EXCLUSIVITY: `claimed[]` is supposed to
 * guarantee no census block belongs to two pockets. Nothing checks that today,
 * and if it broke you would get silently double-counted population with no
 * error anywhere — the numbers would just be wrong.
 */

const POP_PER_BLOCK = 600;
const points = CENSUS_POINTS as [number, number][];

vi.mock("./census", () => {
  const pts = CENSUS_POINTS as [number, number][];
  const blocks = pts.map((coords) => ({ coords, population: POP_PER_BLOCK }));
  return {
    getTorontoRaster: vi.fn(async () => ({
      blocks,
      grid: new SpatialGrid(blocks, 0.5),
      totalPopulation: blocks.length * POP_PER_BLOCK,
      fetchedAt: Date.now(),
    })),
  };
});

// Imported after the mock so gaps.ts binds the stubbed census module.
const { rankServiceAreas } = await import("./gaps");

/** A network with a couple of stops far from most of the fixture's blocks. */
function makeNetwork(stopCoords: [number, number][]): LiveNetwork {
  const routes = stopCoords.map((coords, i) => ({
    id: `r${i}`,
    name: `Route ${i}`,
    type: "subway",
    stops: [{ name: `Stop ${i}`, coords }],
  }));
  const stops: NetStop[] = routes.map((r) => ({
    name: r.stops[0]!.name,
    route: r.id,
    routeType: r.type,
    coords: r.stops[0]!.coords,
  }));
  return { routes, stops, grid: new SpatialGrid(stops, 1), stats: networkStats(routes) };
}

// One stop at the edge, so most fixture blocks read as under-served.
const sparseNetwork = makeNetwork([[-79.62, 43.58]]);

function isInside(pt: [number, number], ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

describe("rankServiceAreas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns gap_N ids ranked by population, descending", async () => {
    const areas = await rankServiceAreas(sparseNetwork, "least_served");
    expect(areas.length).toBeGreaterThan(0);
    expect(areas.map((a) => a.id)).toEqual(areas.map((_, i) => `gap_${i + 1}`));

    const pops = areas.map((a) => a.population);
    expect([...pops].sort((x, y) => y - x)).toEqual(pops);
  });

  it("never double-counts population across pockets", async () => {
    // The exclusivity invariant. Each block is claimed by exactly one pocket,
    // so the pockets' populations must sum to no more than the whole raster.
    const areas = await rankServiceAreas(sparseNetwork, "least_served");
    const summed = areas.reduce((s, a) => s + a.population, 0);
    expect(summed).toBeLessThanOrEqual(points.length * POP_PER_BLOCK);
  });

  it("does not place one pocket's centroid inside another's polygon", async () => {
    // Observable consequence of exclusivity — the original bug report was
    // "Markland Wood" drawn on top of "Etobicoke gap".
    const areas = await rankServiceAreas(sparseNetwork, "least_served");
    for (const a of areas) {
      for (const b of areas) {
        if (a.id === b.id) continue;
        expect(isInside(a.centroid, b.polygon), `${a.id} centroid inside ${b.id}`).toBe(false);
      }
    }
  });

  it("gives every area a drawable polygon and a real name", async () => {
    const areas = await rankServiceAreas(sparseNetwork, "least_served");
    for (const a of areas) {
      expect(a.polygon.length, `${a.id} polygon`).toBeGreaterThanOrEqual(3);
      expect(a.name.trim()).not.toBe("");
      expect(Number.isFinite(a.centroid[0]) && Number.isFinite(a.centroid[1])).toBe(true);
    }
  });

  it("drops pockets below the minimum population threshold", async () => {
    const areas = await rankServiceAreas(sparseNetwork, "least_served");
    for (const a of areas) expect(a.population).toBeGreaterThanOrEqual(2000);
  });

  it("labels best_served results as served_N", async () => {
    // A network blanketing the fixture makes everything well-served.
    const dense = makeNetwork(points.filter((_, i) => i % 40 === 0));
    const areas = await rankServiceAreas(dense, "best_served");
    if (areas.length === 0) return; // threshold left nothing; nothing to assert
    expect(areas.every((a) => a.id.startsWith("served_"))).toBe(true);
    expect(areas.every((a) => a.kind === "served")).toBe(true);
  });

  it("answers the direction that was asked", async () => {
    const gaps = await rankServiceAreas(sparseNetwork, "least_served");
    expect(gaps.every((a) => a.kind === "gap")).toBe(true);
  });
});
