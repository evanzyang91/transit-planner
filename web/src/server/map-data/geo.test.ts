import { describe, expect, it } from "vitest";

import { cellUnionOutline, convexHull, KM_PER_DEG_LAT, KM_PER_DEG_LNG } from "./geo";
import CENSUS_POINTS from "./__fixtures__/census-points.json";

/**
 * These tests exist because an earlier version of cellUnionOutline shipped a
 * regression that a full synthetic test suite failed to catch.
 *
 * That version INFERRED a grid step from the data, assuming census blocks sat
 * on a regular ~1 km lattice. They don't — pop_data holds irregularly spaced
 * dissemination-block centroids. It inferred sub-metre cells, so every block
 * became its own island and a 19,836-person gap rendered as a 1 m dot.
 *
 * Eleven synthetic tests passed throughout, because they were written on
 * generated lattice data and so encoded the very assumption they should have
 * been testing. The fixture here is REAL Supabase output for that reason: a
 * test that agrees with a wrong premise is worse than no test at all.
 */

const points = CENSUS_POINTS as [number, number][];

const kmBetween = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * KM_PER_DEG_LNG, (a[1] - b[1]) * KM_PER_DEG_LAT);

/** Blocks within `radiusKm` of a seed — the same shape gaps.ts feeds in. */
function pocketAround(seed: [number, number], radiusKm = 2.5): [number, number][] {
  return points.filter((p) => kmBetween(p, seed) < radiusKm);
}

function extentKm(ring: [number, number][]): { widthKm: number; heightKm: number } {
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return {
    widthKm: (Math.max(...lngs) - Math.min(...lngs)) * KM_PER_DEG_LNG,
    heightKm: (Math.max(...lats) - Math.min(...lats)) * KM_PER_DEG_LAT,
  };
}

/** 📖 Learn: ray casting — count edge crossings; odd means inside. */
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

function shoelaceArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

describe("cellUnionOutline on real census data", () => {
  const seeds: [number, number][] = [
    points[0]!,
    points[137]!,
    points[274]!,
    points[411]!,
    points[548]!,
  ];

  it("has the 1000-point fixture available", () => {
    expect(points.length).toBe(1000);
    expect(points[0]).toHaveLength(2);
  });

  it.each(seeds.map((s, i) => [i, s] as const))(
    "pocket %i outlines at kilometre scale, not metres",
    (_i, seed) => {
      const pocket = pocketAround(seed);
      expect(pocket.length).toBeGreaterThan(20);

      const { widthKm, heightKm } = extentKm(cellUnionOutline(pocket));

      // THE REGRESSION: the broken version produced ~0.001 km across.
      expect(widthKm).toBeGreaterThan(0.5);
      expect(heightKm).toBeGreaterThan(0.5);
      // And it must not balloon past the 2.5 km seed radius (5 km diameter).
      expect(widthKm).toBeLessThan(7);
      expect(heightKm).toBeLessThan(7);
    },
  );

  it.each(seeds.map((s, i) => [i, s] as const))(
    "pocket %i outline contains at least 90 percent of its own blocks",
    (_i, seed) => {
      const pocket = pocketAround(seed);
      const ring = cellUnionOutline(pocket);
      const contained = pocket.filter((p) => isInside(p, ring)).length;

      // Only the largest ring is kept, so too fine a grid fragments the pocket
      // into islands and strands most of its population outside the outline.
      // At CELL_KM = 0.35 this was ~32%.
      expect(contained / pocket.length).toBeGreaterThanOrEqual(0.9);
    },
  );

  it("produces more bends than a convex hull of the same blocks", () => {
    const pocket = pocketAround(seeds[0]!);
    // The whole point of replacing convexHull: a hull cannot have concavities,
    // so it spans parkland and rail yards that contain nobody.
    expect(cellUnionOutline(pocket).length).toBeGreaterThan(convexHull(pocket).length);
  });

  it("smoothing only cuts corners — it never inflates the footprint", () => {
    const pocket = pocketAround(seeds[0]!);
    const smoothed = shoelaceArea(cellUnionOutline(pocket, 2));
    const raw = shoelaceArea(cellUnionOutline(pocket, 0));
    expect(smoothed).toBeLessThan(raw);
  });

  it("gives disjoint pockets non-overlapping outlines", () => {
    // The original bug report: "Markland Wood" drawn on top of "Etobicoke gap".
    // Disjoint block sets can still yield INTERSECTING convex hulls; a cell
    // union of exclusive cells cannot.
    const a = pocketAround(seeds[0]!, 1.2);
    const b = points.filter((p) => kmBetween(p, seeds[0]!) > 6 && kmBetween(p, seeds[3]!) < 1.2);
    if (b.length < 20) return; // fixture too sparse here; nothing to assert

    const ringA = cellUnionOutline(a);
    const ringB = cellUnionOutline(b);
    expect(a.some((p) => isInside(p, ringB))).toBe(false);
    expect(b.some((p) => isInside(p, ringA))).toBe(false);
  });

  it("returns [] for degenerate input rather than a bogus shape", () => {
    expect(cellUnionOutline([])).toEqual([]);
  });

  it("keeps a single isolated block to one cell, not a dot", () => {
    const ring = cellUnionOutline([points[0]!]);
    const { widthKm } = extentKm(ring);
    // One 0.75 km cell, smoothed — must still be a real, visible shape.
    expect(widthKm).toBeGreaterThan(0.3);
    expect(widthKm).toBeLessThan(1.5);
  });
});
