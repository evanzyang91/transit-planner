import { describe, expect, it } from "vitest";

import BASELINE from "./__fixtures__/baseline-routes.json";
import GOLDEN from "./__fixtures__/golden-selections.json";
import {
  GATE_DEFAULTS,
  MODE_COSTS,
  computeCoverage,
  computeGeometry,
  computeRouteMetrics,
  costBn,
  evaluateGate,
  pathKm,
  populationSourceFromBlocks,
  throughPathKm,
  type MetricStop,
  type PopulationBlock,
  type SelectedArea,
} from "./route-metrics";

/**
 * Every expected value below is derived by hand from the geometry, not copied
 * out of a run. Where a number is not exact it is because the module measures
 * distance with the haversine formula but does plane geometry on a local
 * equirectangular projection; the two disagree by ~0.6%, so km assertions carry
 * a 100 m tolerance and angle assertions a 0.5° one. Test coordinates are built
 * so the HAVERSINE distances are the round numbers a reader would check.
 */

// 6371 km × π/180 — the km per degree of latitude implied by `haversineKm`.
const DEG_LAT = 6371 * (Math.PI / 180);
const ORIGIN: [number, number] = [-79.4, 43.7];

/** A point `eastKm` east and `northKm` north of ORIGIN. */
function at(eastKm: number, northKm: number): [number, number] {
  const lat = ORIGIN[1] + northKm / DEG_LAT;
  const lng = ORIGIN[0] + eastKm / (DEG_LAT * Math.cos((lat * Math.PI) / 180));
  return [lng, lat];
}

const stop = (name: string, eastKm: number, northKm: number): MetricStop => ({
  name,
  coords: at(eastKm, northKm),
});

/** A `sideKm`-sided axis-aligned square centred on (eastKm, northKm). */
function square(name: string, eastKm: number, northKm: number, sideKm = 1): SelectedArea {
  const h = sideKm / 2;
  return {
    name,
    ring: [
      at(eastKm - h, northKm - h),
      at(eastKm + h, northKm - h),
      at(eastKm + h, northKm + h),
      at(eastKm - h, northKm + h),
    ],
  };
}

const block = (eastKm: number, northKm: number, population: number): PopulationBlock => ({
  coords: at(eastKm, northKm),
  population,
});

const NO_POPULATION = populationSourceFromBlocks([]);

// ── Geometry ──────────────────────────────────────────────────────────────────

describe("computeGeometry", () => {
  it("measures a straight 2 km line as perfectly straight", () => {
    // Three stops due east at 1 km spacing: 2 km walked, 2 km as the crow flies.
    const g = computeGeometry([stop("A", 0, 0), stop("B", 1, 0), stop("C", 2, 0)]);

    expect(g.totalKm).toBeCloseTo(2, 1);
    expect(g.straightLineKm).toBeCloseTo(2, 1);
    expect(g.sinuosity).toBeCloseTo(1, 2);
    expect(g.turnAnglesDeg).toHaveLength(1); // one interior stop
    expect(g.turnAnglesDeg[0]).toBeCloseTo(0, 0);
    expect(g.maxTurnDeg).toBeCloseTo(0, 0);
    expect(g.sharpTurns).toBe(0);
    expect(g.reversals).toBe(0);
    expect(g.selfIntersections).toBe(0);
  });

  it("measures a right-angle corner as a 90° turn, and counts it as sharp", () => {
    // 1 km east, then 1 km north. Walked 2 km; crow-flies √2 ≈ 1.414 km.
    const g = computeGeometry([stop("A", 0, 0), stop("B", 1, 0), stop("C", 1, 1)]);

    expect(g.turnAnglesDeg[0]).toBeCloseTo(90, 0);
    expect(g.straightLineKm).toBeCloseTo(Math.SQRT2, 1);
    expect(g.sinuosity).toBeCloseTo(2 / Math.SQRT2, 1); // ≈ 1.414
    expect(g.sharpTurns).toBe(1); // > 60°
    expect(g.reversals).toBe(0); // but not > 120°
  });

  it("measures a 135° doubling-back as a reversal", () => {
    // East to (1,0), then north-WEST to (0,1): heading swings from 0° to 135°.
    const g = computeGeometry([stop("A", 0, 0), stop("B", 1, 0), stop("C", 0, 1)]);

    expect(g.turnAnglesDeg[0]).toBeCloseTo(135, 0);
    expect(g.sharpTurns).toBe(1);
    expect(g.reversals).toBe(1);
  });

  it("finds the crossing in a bow-tie and ignores the shared endpoints", () => {
    // (0,0) → (2,2) → (2,0) → (0,2). The first and third segments cross at (1,1);
    // the adjacent pairs only touch, which is not a crossing.
    const g = computeGeometry([
      stop("A", 0, 0), stop("B", 2, 2), stop("C", 2, 0), stop("D", 0, 2),
    ]);

    expect(g.selfIntersections).toBe(1);
  });

  it("does not report a crossing for a plain L", () => {
    const g = computeGeometry([stop("A", 0, 0), stop("B", 3, 0), stop("C", 3, 3)]);
    expect(g.selfIntersections).toBe(0);
  });

  it("counts spacing violations on both sides of the 800–1500 m band", () => {
    // Gaps of 0.5 km (too close), 1.0 km (fine), 2.0 km (too far).
    const g = computeGeometry([
      stop("A", 0, 0), stop("B", 0.5, 0), stop("C", 1.5, 0), stop("D", 3.5, 0),
    ]);

    expect(g.spacingKm.map((k) => +k.toFixed(2))).toEqual([0.5, 1, 2]);
    expect(g.spacingViolations).toEqual({ tooClose: 1, tooFar: 1 });
  });

  it("reports Infinity sinuosity for a closed loop rather than calling it straight", () => {
    const g = computeGeometry([
      stop("A", 0, 0), stop("B", 1, 0), stop("C", 1, 1), stop("A again", 0, 0),
    ]);
    expect(g.sinuosity).toBe(Infinity);
  });

  it("returns a neutral result for a route with fewer than two stops", () => {
    expect(computeGeometry([stop("only", 0, 0)]).totalKm).toBe(0);
    expect(computeGeometry([]).sinuosity).toBe(1);
  });

  it("pathKm agrees with the geometry total", () => {
    const stops = [stop("A", 0, 0), stop("B", 1, 0), stop("C", 1, 1)];
    expect(pathKm(stops)).toBeCloseTo(computeGeometry(stops).totalKm, 9);
  });
});

// ── Cost ──────────────────────────────────────────────────────────────────────

describe("costBn", () => {
  it("is km × unit cost + stations × station cost, for a subway", () => {
    // 10 km × $0.5B + 8 stations × $0.15B = $5.0B + $1.2B = $6.2B.
    expect(costBn(10, 8, "subway")).toBeCloseTo(6.2, 10);
  });

  it("charges per mode", () => {
    // 10 km × $0.08B + 8 × $0.025B = $0.8B + $0.2B = $1.0B.
    expect(costBn(10, 8, "lrt")).toBeCloseTo(1.0, 10);
    expect(costBn(10, 8, "bus")).toBeCloseTo(10 * 0.004 + 8 * 0.001, 10);
  });

  it("defaults to subway, because every council route is one", () => {
    expect(costBn(10, 8)).toBe(costBn(10, 8, "subway"));
  });

  it("separates two same-length routes by their stop count", () => {
    // The gap the old `km × 0.5` formula could not see: identical length,
    // 14 extra stations, $2.1B apart.
    expect(costBn(12, 20, "subway") - costBn(12, 6, "subway")).toBeCloseTo(2.1, 10);
  });

  it("keeps the per-km figures the UI already shows users", () => {
    expect(MODE_COSTS.subway.perKmBn).toBe(0.5); // $500M/km, TransitMap.tsx
    expect(MODE_COSTS.lrt.perKmBn).toBe(0.08); //  $80M/km
    expect(MODE_COSTS.bus.perKmBn).toBe(0.004); // $4M/km
  });
});

// ── Coverage ──────────────────────────────────────────────────────────────────

describe("computeCoverage", () => {
  it("counts a block reachable from two stops ONCE (union, not sum)", () => {
    // The midpoint block is 0.5 km from each stop — inside both walk-sheds.
    // A per-stop sum would report 2,000; the union reports 1,000.
    const stops = [stop("A", 0, 0), stop("B", 1, 0)];
    const pop = populationSourceFromBlocks([
      block(0.5, 0, 1000), // within 0.8 km of both stops
      block(5, 0, 500), //   4 km from the nearest stop — out of reach
    ]);

    const c = computeCoverage(stops, pop, { walkKm: 0.8 });
    expect(c.servedPop).toBe(1000);
  });

  it("respects the 800 m walk radius at its edge", () => {
    const stops = [stop("A", 0, 0)];
    const pop = populationSourceFromBlocks([block(0.75, 0, 100), block(0.9, 0, 100)]);
    expect(computeCoverage(stops, pop, { walkKm: 0.8 }).servedPop).toBe(100);
    // Widen the radius and the second block comes in.
    expect(computeCoverage(stops, pop, { walkKm: 1.0 }).servedPop).toBe(200);
  });

  it("subtracts only the catchment the existing network ALREADY had", () => {
    // Stop A sits on top of an existing station; stop B is 3 km away, clear of it.
    const stops = [stop("A", 0, 0), stop("B", 3, 0)];
    const existing = [stop("Existing", 0, 0)];
    const pop = populationSourceFromBlocks([
      block(0.2, 0, 1000), // near A — and already served by Existing
      block(3.1, 0, 700), //  near B — new catchment
      block(9, 0, 400), //    nowhere near anything
    ]);

    const c = computeCoverage(stops, pop, { existingStops: existing, walkKm: 0.8 });
    expect(c.servedPop).toBe(1700); // 1000 + 700
    expect(c.existingNetworkPop).toBe(1000);
    expect(c.overlapPop).toBe(1000);
    expect(c.netNewPop).toBe(700); // 1700 − 1000
  });

  it("never lets netNewPop go negative when the existing network is large", () => {
    // A city-wide existing network dwarfs this route. The literal reading of
    // "servedPop minus the existing network's population" would be −9,000.
    const stops = [stop("A", 0, 0)];
    const existing = [stop("E1", 20, 0), stop("E2", 20, 1)];
    const pop = populationSourceFromBlocks([block(0.1, 0, 1000), block(20, 0, 10000)]);

    const c = computeCoverage(stops, pop, { existingStops: existing, walkKm: 0.8 });
    expect(c.existingNetworkPop).toBe(10000);
    expect(c.overlapPop).toBe(0);
    expect(c.netNewPop).toBe(1000);
  });

  it("reports each selected area's covered share of its own population", () => {
    // One 4 km square holding four blocks totalling 2,000 people. The single
    // stop sits within 800 m of the two nearest (300 + 700 = 1,000) — half.
    const area = square("Testville", 0, 0, 4);
    const pop = populationSourceFromBlocks([
      block(0.3, 0.2, 300), // 0.36 km from the stop — served
      block(-0.4, 0.3, 700), // 0.50 km — served
      block(1.6, 1.5, 400), // 2.19 km — not served
      block(-1.7, -1.4, 600), // 2.20 km — not served
    ]);

    const c = computeCoverage([stop("Middle", 0, 0)], pop, { areas: [area], walkKm: 0.8 });
    expect(c.areaCoverage).toHaveLength(1);
    expect(c.areaCoverage[0]!.name).toBe("Testville");
    expect(c.areaCoverage[0]!.population).toBe(2000);
    expect(c.areaCoverage[0]!.servedPopulation).toBe(1000);
    expect(c.areaCoverage[0]!.share).toBeCloseTo(0.5, 10);
    expect(c.minAreaCoverage).toBeCloseTo(0.5, 10);
  });

  it("ignores population that lies outside the selected area's polygon", () => {
    const area = square("Small", 0, 0, 1);
    const pop = populationSourceFromBlocks([
      block(0, 0, 500), // inside the square, and served
      block(0.7, 0, 900), // 700 m away: served, but OUTSIDE the 500 m half-width
    ]);

    const c = computeCoverage([stop("Middle", 0, 0)], pop, { areas: [area], walkKm: 0.8 });
    expect(c.servedPop).toBe(1400); // city-wide coverage counts both
    expect(c.areaCoverage[0]!.population).toBe(500); // the area's own, only
    expect(c.areaCoverage[0]!.share).toBe(1);
  });

  it("gives an unpopulated area a share of 0, not NaN", () => {
    const c = computeCoverage([stop("A", 0, 0)], NO_POPULATION, { areas: [square("Empty", 0, 0)] });
    expect(c.areaCoverage[0]!.share).toBe(0);
    expect(c.minAreaCoverage).toBe(0);
  });

  it("is a pure function of its inputs — the same call twice gives the same answer", () => {
    const stops = [stop("A", 0, 0), stop("B", 1, 0)];
    const pop = populationSourceFromBlocks([block(0.5, 0, 1000)]);
    expect(computeCoverage(stops, pop)).toEqual(computeCoverage(stops, pop));
  });
});

// ── Detour index ──────────────────────────────────────────────────────────────

describe("throughPathKm", () => {
  it("is the shortest path touching every selected polygon, not their centres", () => {
    // Three 1 km squares centred 2 km apart in a row. The shortest path that
    // passes through all three runs corner-to-corner: 0.5 km inside the first
    // square's edge to 0.5 km inside the last's, i.e. 4 km − 0.5 − 0.5 = 3 km.
    const areas = [square("A", 0, 0), square("B", 2, 0), square("C", 4, 0)];
    expect(throughPathKm(areas)).toBeCloseTo(3, 1);
  });

  it("bends where an L-shaped selection has to bend", () => {
    // Areas at (0,0), (3,0), (3,3). Any path must cover both legs, so the
    // denominator is ~ (3−1) + (3−1) = 4 km, not the 4.24 km diagonal.
    const areas = [square("W", 0, 0), square("Corner", 3, 0), square("N", 3, 3)];
    const through = throughPathKm(areas);
    expect(through).toBeCloseTo(4, 1);

    // The point of the detour index: an L-shaped route scores ~1 here, while its
    // sinuosity is a misleading 1.41.
    const lRoute = [stop("W", 0, 0), stop("Corner", 3, 0), stop("N", 3, 3)];
    const metrics = computeRouteMetrics({ stops: lRoute, population: NO_POPULATION, areas });
    expect(metrics.geometry.sinuosity).toBeCloseTo(1.41, 1);
    expect(metrics.detour.detourIndex).toBeLessThan(1.6);
  });

  it("is 0 for fewer than two areas, and the detour index then falls back to 1", () => {
    expect(throughPathKm([])).toBe(0);
    expect(throughPathKm([square("Only", 0, 0)])).toBe(0);
    const m = computeRouteMetrics({
      stops: [stop("A", 0, 0), stop("B", 1, 0)],
      population: NO_POPULATION,
      areas: [square("Only", 0, 0)],
    });
    expect(m.detour.detourIndex).toBe(1);
  });

  it("does not depend on the order the areas are listed in", () => {
    const areas = [square("A", 0, 0), square("B", 2, 0), square("C", 4, 0)];
    const shuffled = [areas[2]!, areas[0]!, areas[1]!];
    expect(throughPathKm(shuffled)).toBeCloseTo(throughPathKm(areas), 6);
  });

  it("orders more than eight areas heuristically, and still beats the listed order", () => {
    // Twelve squares along a line, deliberately listed out of order. The 2-opt
    // fallback must find something no longer than walking them as listed.
    const xs = [0, 8, 2, 10, 4, 14, 6, 16, 12, 18, 20, 22];
    const areas = xs.map((x, i) => square(`A${i}`, x, 0));
    const listedOrder = xs.slice(1).reduce((s, x, i) => s + Math.abs(x - xs[i]!), 0);

    const through = throughPathKm(areas);
    expect(through).toBeGreaterThan(0);
    expect(through).toBeLessThanOrEqual(listedOrder);
    // Best possible: sweep 0 → 22 along the row, less half a square at each end.
    expect(through).toBeCloseTo(21, 0);
  });
});

// ── The whole picture ─────────────────────────────────────────────────────────

describe("computeRouteMetrics", () => {
  it("reports efficiency as net new catchment per $B, and served people per km", () => {
    // Two stops 2 km apart. Cost = 2 km × $0.5B + 2 × $0.15B = $1.3B.
    // 5,000 served, of which 2,000 the existing network already had.
    const stops = [stop("A", 0, 0), stop("B", 2, 0)];
    const m = computeRouteMetrics({
      stops,
      population: populationSourceFromBlocks([block(0, 0, 2000), block(2, 0, 3000)]),
      existingStops: [stop("Old", 0, 0)],
    });

    expect(m.cost.costBn).toBeCloseTo(1.3, 1);
    expect(m.coverage.servedPop).toBe(5000);
    expect(m.coverage.netNewPop).toBe(3000);
    expect(m.efficiency.netNewPopPerBn).toBeCloseTo(3000 / 1.3, 0); // ≈ 2,308
    expect(m.efficiency.servedPopPerKm).toBeCloseTo(2500, 0); // 5,000 / 2 km
  });

  it("does not divide by zero for a route with no length", () => {
    const m = computeRouteMetrics({ stops: [stop("A", 0, 0)], population: NO_POPULATION });
    expect(m.efficiency.servedPopPerKm).toBe(0);
    expect(Number.isFinite(m.efficiency.netNewPopPerBn)).toBe(true);
  });
});

// ── The gate ──────────────────────────────────────────────────────────────────

describe("evaluateGate", () => {
  const cleanRoute = [stop("A", 0, 0), stop("B", 1, 0), stop("C", 2, 0), stop("D", 3, 0)];

  it("passes a straight, well-spaced, fully covering route", () => {
    // Small (100 m) areas, so the through-path denominator is the 3 km between
    // them rather than their own width — see the bias test below.
    const areas = [square("A", 0, 0, 0.1), square("D", 3, 0, 0.1)];
    const m = computeRouteMetrics({
      stops: cleanRoute,
      areas,
      population: populationSourceFromBlocks([block(0, 0, 1000), block(3, 0, 1000)]),
    });
    expect(evaluateGate(m)).toEqual({ passed: true, failures: [] });
  });

  it("scores even a flawless route above 1 when the areas are city-sized", () => {
    // The documented lower-bound bias: the denominator may clip an area's
    // corner, but a route has to reach its middle. Two 1 km squares 3 km apart
    // give a through-path of 3 − 0.5 − 0.5 = 2 km, so a perfect 3 km straight
    // line scores 1.5 — above the report's proposed 1.3 ceiling.
    const areas = [square("A", 0, 0), square("D", 3, 0)];
    const m = computeRouteMetrics({
      stops: cleanRoute,
      areas,
      population: populationSourceFromBlocks([block(0, 0, 1000), block(3, 0, 1000)]),
    });

    expect(m.geometry.sinuosity).toBeCloseTo(1, 2); // the route itself is straight
    expect(m.detour.throughPathKm).toBeCloseTo(2, 1);
    expect(m.detour.detourIndex).toBeCloseTo(1.5, 1);
    expect(evaluateGate(m).failures).toEqual(["detour index 1.50 exceeds 1.3"]);
  });

  it("names every reason a bad route fails", () => {
    const m = computeRouteMetrics({
      stops: [stop("A", 0, 0), stop("B", 2, 2), stop("C", 2, 0), stop("D", 0, 2)],
      population: NO_POPULATION,
    });
    const gate = evaluateGate(m);

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(" | ")).toMatch(/self-intersection/);
    expect(gate.failures.join(" | ")).toMatch(/reversal|worst turn/);
    expect(gate.failures.join(" | ")).toMatch(/outside 0\.8–1\.5 km/);
  });

  it("uses the thresholds the report proposed", () => {
    expect(GATE_DEFAULTS.maxSelfIntersections).toBe(0);
    expect(GATE_DEFAULTS.maxReversals).toBe(0);
    expect(GATE_DEFAULTS.maxTurnDeg).toBe(60);
    expect(GATE_DEFAULTS.minAreaCoverage).toBe(0.25);
    expect(GATE_DEFAULTS.maxDetourIndex).toBe(1.3);
  });
});

// ── The failures the investigation demonstrated ───────────────────────────────

describe("the failures this module exists to catch", () => {
  it("E5: catches the self-crossing route `repairRoute` lets through untouched", () => {
    // `repairRoute` only drops out-of-bounds stops, merges near-duplicates and
    // relabels transfers — it never looks at shape. This route survives it
    // intact while crossing itself three times. Segments, in order:
    //   s0 (0,0)→(3,2)   s1 (3,2)→(0,2)   s2 (0,2)→(3,0)   s3 (3,0)→(1.5,3)
    // Non-adjacent pairs and where they cross:
    //   s0 × s2 at (1.5, 1)     — y = 2x/3 meets y = 2 − 2x/3
    //   s0 × s3 at (2.25, 1.5)  — y = 2x/3 meets y = 6 − 2x
    //   s1 × s3 at (2, 2)       — y = 2 meets y = 6 − 2x
    const crossing = [
      stop("1", 0, 0),
      stop("2", 3, 2),
      stop("3", 0, 2),
      stop("4", 3, 0),
      stop("5", 1.5, 3),
    ];
    const g = computeGeometry(crossing);

    expect(g.selfIntersections).toBe(3);
    expect(g.sharpTurns).toBeGreaterThanOrEqual(2);
    expect(evaluateGate(
      computeRouteMetrics({ stops: crossing, population: NO_POPULATION }),
    ).passed).toBe(false);
  });

  it("E2: catches a U-shaped corridor with one stop swapped out of order", () => {
    // A clean U: south down the west leg, east along the bottom, north up the east.
    const correct = [
      stop("W1", 0, 3), stop("W2", 0, 1.5), stop("SW", 0, 0),
      stop("SE", 3, 0), stop("E1", 3, 1.5), stop("E2", 3, 3),
    ];
    // `sortRouteStops` projects onto the axis between the two farthest stops.
    // For a U those are W1 and E2, and the projection order is NOT the U — so it
    // keeps whatever the model sent, swap and all.
    const swapped = [
      correct[0]!, correct[4]!, correct[2]!, correct[3]!, correct[1]!, correct[5]!,
    ];

    const clean = computeGeometry(correct);
    const broken = computeGeometry(swapped);

    // The correct U has two legitimate 90° corners and nothing else wrong.
    expect(clean.selfIntersections).toBe(0);
    expect(clean.reversals).toBe(0);
    expect(clean.maxTurnDeg).toBeCloseTo(90, 0);

    // One swap turns it into a tangle, and every metric says so.
    expect(broken.selfIntersections).toBeGreaterThan(0);
    expect(broken.reversals).toBeGreaterThan(0);
    expect(broken.totalKm).toBeGreaterThan(clean.totalKm * 1.5);
    expect(broken.sinuosity).toBeGreaterThan(clean.sinuosity);
  });

  it("E3: catches the Dorset Park / Bendale South / Ionview collapse", () => {
    // The real case: three mutually adjacent Scarborough neighbourhoods, for
    // which the council emitted a 0.36 km route that served nobody. Polygons and
    // names come from the City's own file, via the golden-selection fixture.
    const selection = GOLDEN.selections.find((s) => s.id === "adjacent-scarborough-trio")!;
    const areas: SelectedArea[] = selection.codes.map((code) => {
      const a = (GOLDEN.areas as Record<string, { name: string; ring: number[][] }>)[code]!;
      return { name: a.name, ring: a.ring as [number, number][] };
    });
    expect(areas.map((a) => a.name)).toEqual(["Dorset Park", "Bendale South", "Ionview"]);

    // 10,000 people at each area's centre, and nobody in between.
    const centres = areas.map((a) => {
      let lng = 0, lat = 0;
      for (const [x, y] of a.ring) { lng += x; lat += y; }
      return [lng / a.ring.length, lat / a.ring.length] as [number, number];
    });
    const population = populationSourceFromBlocks(
      centres.map((coords) => ({ coords, population: 10000 })),
    );

    // The collapsed route: two stops 0.36 km apart, at the centroid of the three
    // areas' centres — over 1.5 km from every one of them.
    const mid: [number, number] = [
      centres.reduce((s, c) => s + c[0], 0) / 3,
      centres.reduce((s, c) => s + c[1], 0) / 3,
    ];
    const offset = 0.18 / (DEG_LAT * Math.cos((mid[1] * Math.PI) / 180));
    const collapsed: MetricStop[] = [
      { name: "Stop 1", coords: [mid[0] - offset, mid[1]] },
      { name: "Stop 2", coords: [mid[0] + offset, mid[1]] },
    ];

    const m = computeRouteMetrics({ stops: collapsed, areas, population });

    expect(m.geometry.totalKm).toBeCloseTo(0.36, 2);
    expect(m.geometry.spacingViolations.tooClose).toBe(1); // 0.36 km < 800 m

    // Serves nobody, in every sense.
    expect(m.coverage.servedPop).toBe(0);
    expect(m.coverage.netNewPop).toBe(0);
    expect(m.coverage.minAreaCoverage).toBe(0);
    expect(m.coverage.areaCoverage.map((a) => a.share)).toEqual([0, 0, 0]);
    expect(m.efficiency.netNewPopPerBn).toBe(0);

    // The detour index does NOT catch this, and that is the documented reason
    // coverage has to: these three areas are mutually adjacent, so the shortest
    // path through all three barely exceeds the collapsed route's own length.
    // The ratio ends up BELOW 1, which no "too long" threshold can flag.
    expect(m.detour.throughPathKm).toBeGreaterThan(m.geometry.totalKm);
    expect(m.detour.detourIndex).toBeLessThan(0.5);

    const gate = evaluateGate(m);
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(" | ")).toMatch(/only 0% covered/);
  });
});

// ── The golden selections ─────────────────────────────────────────────────────

describe("golden-selections fixture", () => {
  it("covers every shape the report asked for", () => {
    const shapes = new Set(GOLDEN.selections.map((s) => s.shape));
    expect(shapes).toEqual(new Set(["collinear", "L", "U", "scattered", "adjacent", ">8 areas"]));
    expect(GOLDEN.selections.length).toBeGreaterThanOrEqual(12);
    expect(GOLDEN.selections.some((s) => s.codes.length > 8)).toBe(true);
  });

  it("references only areas it also defines, with usable rings", () => {
    const areas = GOLDEN.areas as Record<string, { name: string; ring: number[][] }>;
    for (const s of GOLDEN.selections) {
      expect(s.codes).toHaveLength(s.names.length);
      for (const [i, code] of s.codes.entries()) {
        const a = areas[code];
        expect(a, `selection ${s.id} references unknown area ${code}`).toBeDefined();
        expect(a!.name).toBe(s.names[i]);
        expect(a!.ring.length).toBeGreaterThanOrEqual(4);
        for (const [lng, lat] of a!.ring) {
          expect(lng).toBeGreaterThan(-79.75);
          expect(lng).toBeLessThan(-79.05);
          expect(lat).toBeGreaterThan(43.55);
          expect(lat).toBeLessThan(43.95);
        }
      }
    }
  });

  it("gives every selection a finite through-path, zero only where areas touch", () => {
    const areas = GOLDEN.areas as Record<string, { name: string; ring: number[][] }>;
    for (const s of GOLDEN.selections) {
      const through = throughPathKm(
        s.codes.map((c) => ({ name: areas[c]!.name, ring: areas[c]!.ring as [number, number][] })),
      );
      expect(Number.isFinite(through), s.id).toBe(true);
      expect(through, s.id).toBeGreaterThanOrEqual(0);
      // Only the deliberately mutually-adjacent selections may reach zero — for
      // everything else the detour index has a real denominator.
      if (s.shape !== "adjacent") expect(through, s.id).toBeGreaterThan(0);
    }
  });
});

// ── The recorded live baseline ────────────────────────────────────────────────

/**
 * `baseline-routes.json` holds real council output captured by
 * `scripts/eval-routes.mjs`. These tests do NOT pin how bad today's routes are
 * — that is the PR's job to report, and it is meant to change. They pin that
 * the fixture is internally consistent: every metric that does not need census
 * population must recompute exactly from the stops stored beside it. If a
 * metric definition changes and the fixture is not re-scored (`--recompute`),
 * this fails rather than letting a stale baseline quietly become the target.
 */
describe("baseline-routes fixture", () => {
  const goldenAreas = GOLDEN.areas as Record<string, { name: string; ring: number[][] }>;

  it("records live runs with routes, for selections the golden set defines", () => {
    expect(BASELINE.runs.length).toBeGreaterThanOrEqual(5);
    for (const run of BASELINE.runs) {
      const selection = GOLDEN.selections.find((s) => s.id === run.selectionId);
      expect(selection, `unknown selection ${run.selectionId}`).toBeDefined();
      expect(run.routes.length).toBeGreaterThan(0);
      for (const r of run.routes) expect(r.route.stops.length).toBeGreaterThan(1);
    }
  });

  it("covers a selection of more than eight areas and a mutually adjacent one", () => {
    // The two cases the task required a live capture of.
    expect(BASELINE.runs.some((r) => r.areaCount > 8)).toBe(true);
    expect(BASELINE.runs.some((r) => r.shape === "adjacent")).toBe(true);
  });

  it("recomputes every population-free metric exactly from the recorded stops", () => {
    for (const run of BASELINE.runs) {
      const selection = GOLDEN.selections.find((s) => s.id === run.selectionId)!;
      const areas = selection.codes.map((c) => ({
        name: goldenAreas[c]!.name,
        ring: goldenAreas[c]!.ring as [number, number][],
      }));
      expect(run.throughPathKm, run.selectionId).toBeCloseTo(throughPathKm(areas), 6);

      for (const recorded of run.routes) {
        const where = `${run.selectionId}/${recorded.label}`;
        // JSON widens [lng, lat] to number[]; the fixture's shape is asserted above.
        const stops: MetricStop[] = recorded.route.stops.map((s) => ({
          name: s.name,
          coords: s.coords as [number, number],
        }));

        const geometry = computeGeometry(stops);
        expect(recorded.metrics.geometry, where).toEqual(geometry);
        expect(recorded.metrics.stopCount, where).toBe(stops.length);
        expect(recorded.metrics.cost.costBn, where).toBeCloseTo(
          costBn(geometry.totalKm, stops.length, "subway"), 9,
        );
        expect(recorded.metrics.detour.throughPathKm, where).toBeCloseTo(run.throughPathKm, 6);
      }
    }
  });

  it("records coverage figures that are internally coherent", () => {
    for (const run of BASELINE.runs) {
      for (const { label, metrics } of run.routes) {
        const where = `${run.selectionId}/${label}`;
        const c = metrics.coverage;
        // A union can only shrink when you subtract the part of it the existing
        // network already had, and each area's served share is a proportion.
        expect(c.netNewPop, where).toBe(c.servedPop - c.overlapPop);
        expect(c.overlapPop, where).toBeLessThanOrEqual(c.servedPop);
        expect(c.netNewPop, where).toBeGreaterThanOrEqual(0);
        expect(c.areaCoverage.length, where).toBe(run.areaCount);
        for (const a of c.areaCoverage) {
          expect(a.share, `${where}/${a.name}`).toBeGreaterThanOrEqual(0);
          expect(a.share, `${where}/${a.name}`).toBeLessThanOrEqual(1);
          expect(a.servedPopulation, `${where}/${a.name}`).toBeLessThanOrEqual(a.population);
        }
        expect(c.minAreaCoverage, where).toBeCloseTo(
          Math.min(...c.areaCoverage.map((a) => a.share)), 12,
        );
      }
    }
  });
});
