import "server-only";

/**
 * Route metrics — the one place that answers "is this route any good?".
 *
 * WHY THIS EXISTS: before this module the app could not tell a good route from
 * a bad one. Cost was `km × 0.5` in three divergent places (`council.ts:377`,
 * `TransitMap.tsx:5147`, and prose inside the planner prompts), coverage was
 * not computed at all, and `scoreRoute` ran *after* the route was already
 * emitted, so it gated nothing. Every number defined here comes from §5 of the
 * route-generation report; the definitions are that report's, not invented.
 *
 * TWO HARD RULES, both load-bearing:
 *
 * 1. **Pure, and free of I/O.** Population arrives through the injected
 *    {@link PopulationSource} interface, never through Supabase. That is what
 *    makes these numbers usable as regression tests: a test supplies fixture
 *    blocks and gets an exact, hand-checkable answer. Nothing in this file
 *    awaits, fetches, reads a file, or reads a clock.
 *
 * 2. **It measures; it never repairs.** Nothing here reorders, moves, drops or
 *    rewrites a stop. Callers pass a route in and get numbers out.
 *
 * 📖 Learn: separating *measurement* from *production* is what lets you change
 * the producer safely. A deterministic alignment builder is only demonstrably
 * better than today's model-typed coordinates if both are scored by the same
 * ruler, and that ruler has to exist first.
 */

import { haversineKm } from "~/app/map/geo-utils";

// ── Inputs ────────────────────────────────────────────────────────────────────

/** A stop, reduced to the two fields any metric needs. */
export interface MetricStop {
  name: string;
  coords: [number, number]; // [lng, lat]
}

/** One census block: a point with the population attributed to it. */
export interface PopulationBlock {
  coords: [number, number]; // [lng, lat]
  population: number;
}

/**
 * The injected population oracle.
 *
 * Deliberately one method returning every block in the study region, matching
 * what `populationServedByNetwork` does with the cached raster
 * (`map-data/census.ts:125`): walk every block once and ask whether ANY stop is
 * within walking distance. A narrower "population near this point" interface
 * could not express the union semantics without double-counting.
 */
export interface PopulationSource {
  /** Every census block in the study region. Called once per metrics run. */
  blocks(): readonly PopulationBlock[];
}

/** Wrap a plain array of blocks as a {@link PopulationSource}. */
export function populationSourceFromBlocks(
  blocks: readonly PopulationBlock[],
): PopulationSource {
  return { blocks: () => blocks };
}

/** A user-selected neighbourhood, with the polygon its coverage is measured over. */
export interface SelectedArea {
  name: string;
  /** Outer ring, [lng, lat] pairs. Need not be explicitly closed. */
  ring: readonly [number, number][];
}

export type TransitMode = "subway" | "lrt" | "streetcar" | "bus";

export interface RouteMetricsInput {
  stops: readonly MetricStop[];
  /** Defaults to "subway" — every council route is one (PLANNING RULES §4). */
  mode?: TransitMode;
  population: PopulationSource;
  /** Stops of the network that already exists; drives `netNewPop`. */
  existingStops?: readonly MetricStop[];
  /** The areas the user selected; drives `areaCoverage` and `detourIndex`. */
  areas?: readonly SelectedArea[];
  /** Walk-shed radius. 0.8 km matches `populationServedByNetwork`'s default. */
  walkKm?: number;
  /** Consecutive-spacing band. 0.8–1.5 km is the existing rule (`council-graph.ts:47`). */
  spacing?: { minKm: number; maxKm: number };
}

// ── Cost model ────────────────────────────────────────────────────────────────

/**
 * Per-mode capital cost, in $B.
 *
 * `perKmBn` for subway/LRT/bus reproduces the numbers already shown to users in
 * `TransitMap.tsx:5147` (500 / 80 / 4 $M per km), which is also what
 * `council.ts`'s `km × 0.5` meant when every route is a subway. What that
 * formula was missing is the station term: stations are a large, *stop-count*
 * driven share of real capital cost, so a metric without it rates a 20-stop
 * line and a 6-stop line of the same length identically.
 *
 * `perStationBn` is a documented default, not a measured figure — it is one of
 * the product choices flagged in the report's §7 D5. Order-of-magnitude
 * anchors: recent Toronto subway stations land in the $100–300M range.
 */
export const MODE_COSTS: Record<TransitMode, { perKmBn: number; perStationBn: number }> = {
  subway: { perKmBn: 0.5, perStationBn: 0.15 },
  lrt: { perKmBn: 0.08, perStationBn: 0.025 },
  streetcar: { perKmBn: 0.08, perStationBn: 0.025 },
  bus: { perKmBn: 0.004, perStationBn: 0.001 },
};

/**
 * Capital cost in $B: `km × unitCost(mode) + stations × stationCost(mode)`.
 *
 * THE single source of truth. The three existing formulas stay where they are
 * for now — migrating their callers is a later task — but no new caller should
 * add a fourth.
 */
export function costBn(totalKm: number, stopCount: number, mode: TransitMode = "subway"): number {
  const unit = MODE_COSTS[mode];
  return totalKm * unit.perKmBn + stopCount * unit.perStationBn;
}

// ── Geometry ──────────────────────────────────────────────────────────────────

// Degrees → km at Toronto's latitude. Mirrors KM_PER_DEG_LAT / KM_PER_DEG_LNG in
// `map-data/geo.ts`; duplicated rather than imported because that module pulls in
// the whole neighbourhood catalogue, and this one must stay dependency-light.
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LNG = 111.32 * Math.cos((43.7 * Math.PI) / 180);

type XY = [number, number];

/**
 * Project [lng, lat] onto a local equirectangular km plane.
 *
 * 📖 Learn: over a city-sized span, scaling each axis by its own km-per-degree
 * makes plane geometry (turn angles, segment crossings) agree with great-circle
 * distance to well under a metre — and unlike raw degrees, it does not stretch
 * the north-south axis by 37%, which would fake turn angles that aren't there.
 */
function toPlane([lng, lat]: readonly [number, number]): XY {
  return [lng * KM_PER_DEG_LNG, lat * KM_PER_DEG_LAT];
}

export interface GeometryMetrics {
  /** Great-circle length of the polyline through the stops, in km. */
  totalKm: number;
  /** Straight-line km from first stop to last. */
  straightLineKm: number;
  /** `totalKm / straightLineKm`. 1 = perfectly straight. */
  sinuosity: number;
  /** Deviation from straight-ahead at each interior stop, in degrees (0 = straight). */
  turnAnglesDeg: number[];
  maxTurnDeg: number;
  /** Turns sharper than 60° — the report's sharp-turn threshold. */
  sharpTurns: number;
  /** Turns sharper than 120° — the line doubles back on itself. */
  reversals: number;
  /** Crossings between non-adjacent segments. Never legitimate for one line. */
  selfIntersections: number;
  /** Consecutive stop gaps, in km. */
  spacingKm: number[];
  spacingViolations: { tooClose: number; tooFar: number };
}

/** Total great-circle length of the polyline through `stops`. */
export function pathKm(stops: readonly MetricStop[]): number {
  let km = 0;
  for (let i = 1; i < stops.length; i++) km += haversineKm(stops[i - 1]!.coords, stops[i]!.coords);
  return km;
}

/**
 * Deviation from straight-ahead at B, walking A → B → C, in degrees.
 * 0° means "carry straight on"; 180° means "turn around and go back".
 * Returns 0 for a degenerate (zero-length) leg, which has no defined heading.
 */
function turnDeg(a: XY, b: XY, c: XY): number {
  const ux = b[0] - a[0], uy = b[1] - a[1];
  const vx = c[0] - b[0], vy = c[1] - b[1];
  const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
  if (lu === 0 || lv === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}

/** Sign of the cross product (p→q) × (p→r): which side of pq does r fall on? */
function orient(p: XY, q: XY, r: XY): number {
  const v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  // Tolerance in km²; 1e-12 km² is ~1 µm² — far below any real coordinate.
  if (Math.abs(v) < 1e-12) return 0;
  return v > 0 ? 1 : -1;
}

/**
 * Do segments p1p2 and p3p4 properly cross?
 *
 * 📖 Learn: the standard orientation test. Two segments cross when each
 * straddles the other's line, i.e. the two endpoints of one fall on opposite
 * sides of the other. We deliberately test only PROPER crossings — collinear
 * overlap and touching-at-an-endpoint are excluded, because adjacent segments
 * legitimately share an endpoint and a doubled-back stop is already counted as
 * a reversal rather than as a crossing.
 */
function segmentsCross(p1: XY, p2: XY, p3: XY, p4: XY): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** Every geometric property of a stop sequence. No population involved. */
export function computeGeometry(
  stops: readonly MetricStop[],
  spacing: { minKm: number; maxKm: number } = { minKm: 0.8, maxKm: 1.5 },
): GeometryMetrics {
  const empty: GeometryMetrics = {
    totalKm: 0, straightLineKm: 0, sinuosity: 1,
    turnAnglesDeg: [], maxTurnDeg: 0, sharpTurns: 0, reversals: 0,
    selfIntersections: 0, spacingKm: [], spacingViolations: { tooClose: 0, tooFar: 0 },
  };
  if (stops.length < 2) return empty;

  const spacingKm: number[] = [];
  for (let i = 1; i < stops.length; i++) {
    spacingKm.push(haversineKm(stops[i - 1]!.coords, stops[i]!.coords));
  }
  const totalKm = spacingKm.reduce((s, k) => s + k, 0);
  const straightLineKm = haversineKm(stops[0]!.coords, stops[stops.length - 1]!.coords);

  const plane = stops.map((s) => toPlane(s.coords));
  const turnAnglesDeg: number[] = [];
  for (let i = 1; i < plane.length - 1; i++) {
    turnAnglesDeg.push(turnDeg(plane[i - 1]!, plane[i]!, plane[i + 1]!));
  }

  let selfIntersections = 0;
  for (let i = 0; i + 1 < plane.length; i++) {
    // j starts at i + 2: consecutive segments share an endpoint by construction.
    for (let j = i + 2; j + 1 < plane.length; j++) {
      if (segmentsCross(plane[i]!, plane[i + 1]!, plane[j]!, plane[j + 1]!)) selfIntersections++;
    }
  }

  return {
    totalKm,
    straightLineKm,
    // A closed or near-closed loop has no meaningful sinuosity; report Infinity
    // rather than silently dividing by ~0 and calling a degenerate line straight.
    sinuosity: straightLineKm > 0 ? totalKm / straightLineKm : Infinity,
    turnAnglesDeg,
    maxTurnDeg: turnAnglesDeg.reduce((m, t) => Math.max(m, t), 0),
    sharpTurns: turnAnglesDeg.filter((t) => t > 60).length,
    reversals: turnAnglesDeg.filter((t) => t > 120).length,
    selfIntersections,
    spacingKm,
    spacingViolations: {
      tooClose: spacingKm.filter((k) => k < spacing.minKm).length,
      tooFar: spacingKm.filter((k) => k > spacing.maxKm).length,
    },
  };
}

// ── Detour index ──────────────────────────────────────────────────────────────

/** How many candidate anchors we sample per area's ring, plus its centroid. */
const ANCHORS_PER_AREA = 8;
/** Above this many areas, exact ordering is replaced by nearest-neighbour + 2-opt. */
const EXACT_ORDER_LIMIT = 8;

function ringCentroidXY(ring: readonly (readonly [number, number])[]): XY {
  let x = 0, y = 0;
  for (const p of ring) {
    const q = toPlane(p);
    x += q[0];
    y += q[1];
  }
  return [x / ring.length, y / ring.length];
}

/**
 * Candidate points a path could use to "pass through" an area: the centroid
 * plus up to {@link ANCHORS_PER_AREA} evenly-spaced ring vertices. Sampling the
 * ring matters — a path clipping an area's corner passes through it just as
 * legitimately as one through its middle, and only ring points can express that.
 */
function areaAnchors(area: SelectedArea): XY[] {
  const ring = area.ring;
  if (ring.length === 0) return [];
  const out: XY[] = [ringCentroidXY(ring)];
  const step = Math.max(1, Math.floor(ring.length / ANCHORS_PER_AREA));
  for (let i = 0; i < ring.length && out.length <= ANCHORS_PER_AREA; i += step) {
    out.push(toPlane(ring[i]!));
  }
  return out;
}

const dist = (a: XY, b: XY): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Cheapest open path visiting the areas in the GIVEN order, choosing one anchor
 * per area. Exact, by dynamic programming over (area index, anchor index).
 */
function bestPathForOrder(anchorSets: XY[][], order: number[]): number {
  let prev = anchorSets[order[0]!]!.map(() => 0);
  for (let k = 1; k < order.length; k++) {
    const from = anchorSets[order[k - 1]!]!;
    const to = anchorSets[order[k]!]!;
    const next = to.map((t) => {
      let best = Infinity;
      for (let i = 0; i < from.length; i++) best = Math.min(best, prev[i]! + dist(from[i]!, t));
      return best;
    });
    prev = next;
  }
  return Math.min(...prev);
}

/** Held–Karp over areas: the exact cheapest open order for ≤ EXACT_ORDER_LIMIT areas. */
function exactBestOrderKm(anchorSets: XY[][]): number {
  const n = anchorSets.length;
  // Anchor 0 of each set is that area's centroid (see `areaAnchors`), already projected.
  const centres = anchorSets.map((set) => set[0]!);
  const full = (1 << n) - 1;
  // dp[mask][last] = cheapest centroid path covering `mask` and ending at `last`.
  const dp: number[][] = Array.from({ length: full + 1 }, () => new Array<number>(n).fill(Infinity));
  const parent: number[][] = Array.from({ length: full + 1 }, () => new Array<number>(n).fill(-1));
  for (let i = 0; i < n; i++) dp[1 << i]![i] = 0;
  for (let mask = 1; mask <= full; mask++) {
    for (let last = 0; last < n; last++) {
      const cur = dp[mask]![last]!;
      if (!Number.isFinite(cur) || !(mask & (1 << last))) continue;
      for (let nxt = 0; nxt < n; nxt++) {
        if (mask & (1 << nxt)) continue;
        const cand = cur + dist(centres[last]!, centres[nxt]!);
        const nm = mask | (1 << nxt);
        if (cand < dp[nm]![nxt]!) {
          dp[nm]![nxt] = cand;
          parent[nm]![nxt] = last;
        }
      }
    }
  }
  // Recover the best order, then re-cost it with the full anchor DP: centroids
  // pick the order, anchors pick where within each area the path actually goes.
  let bestEnd = 0;
  for (let i = 1; i < n; i++) if (dp[full]![i]! < dp[full]![bestEnd]!) bestEnd = i;
  const order: number[] = [];
  let mask = full, last = bestEnd;
  while (last !== -1) {
    order.unshift(last);
    const p = parent[mask]![last]!;
    mask ^= 1 << last;
    last = p;
  }
  return bestPathForOrder(anchorSets, order);
}

/** Nearest-neighbour seed + 2-opt improvement — the > 8-area fallback. */
function heuristicOrderKm(anchorSets: XY[][]): number {
  const n = anchorSets.length;
  // Anchor 0 of each set is that area's centroid (see `areaAnchors`), already projected.
  const centres = anchorSets.map((set) => set[0]!);
  const len = (o: number[]) => {
    let s = 0;
    for (let i = 1; i < o.length; i++) s += dist(centres[o[i - 1]!]!, centres[o[i]!]!);
    return s;
  };

  let best: number[] | null = null;
  for (let start = 0; start < n; start++) {
    const order = [start];
    const seen = new Set(order);
    while (order.length < n) {
      const from = order[order.length - 1]!;
      let pick = -1;
      for (let i = 0; i < n; i++) {
        if (seen.has(i)) continue;
        if (pick === -1 || dist(centres[from]!, centres[i]!) < dist(centres[from]!, centres[pick]!)) pick = i;
      }
      order.push(pick);
      seen.add(pick);
    }
    if (!best || len(order) < len(best)) best = order;
  }

  // 📖 Learn: 2-opt repeatedly reverses a sub-path when doing so shortens the
  // tour. It is the cheapest fix for the "crossed over itself" mistakes a
  // greedy nearest-neighbour ordering always makes.
  let order = best!;
  for (let improved = true; improved; ) {
    improved = false;
    for (let i = 1; i < order.length - 1 && !improved; i++) {
      for (let j = i + 1; j < order.length && !improved; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (len(cand) < len(order) - 1e-12) {
          order = cand;
          improved = true;
        }
      }
    }
  }
  return bestPathForOrder(anchorSets, order);
}

/**
 * Length of the shortest open path that passes through every selected area.
 *
 * This is the detour index's DENOMINATOR, and it is a property of the
 * *selection* alone — not of any route — so a selection's value can be computed
 * once and reused. It bends where a legitimate L- or U-shaped corridor has to
 * bend, which is exactly why the report prefers it to plain sinuosity: an
 * L-shaped selection scores a high sinuosity no matter how good the line is,
 * but its detour index stays near 1.
 *
 * TWO PROPERTIES A CALLER MUST KNOW, both consequences of taking
 * "through-polygon" literally:
 *
 * 1. **It is a strict lower bound, so a perfect route scores above 1.** The
 *    path may clip an area's corner, whereas a real alignment has to reach the
 *    populated middle to cover it. For Toronto neighbourhoods (~2 km across) a
 *    flawless straight line through a row of area centres lands near 1.3 — so
 *    the report's proposed `maxDetourIndex` of 1.3 is, on this definition,
 *    roughly the score of a *perfect* route rather than a ceiling on a bad one.
 *    {@link GATE_DEFAULTS} keeps the report's number; the recorded baseline is
 *    there to recalibrate it.
 *
 * 2. **It is 0, and the index therefore meaningless, for mutually adjacent
 *    areas.** Touching polygons share boundary points, so the shortest path
 *    through them has no length. Selections like Dorset Park / Bendale South /
 *    Ionview are caught by `areaCoverage`, not by the detour index.
 */
export function throughPathKm(areas: readonly SelectedArea[]): number {
  const anchorSets = areas.map(areaAnchors).filter((s) => s.length > 0);
  if (anchorSets.length < 2) return 0;
  return anchorSets.length <= EXACT_ORDER_LIMIT
    ? exactBestOrderKm(anchorSets)
    : heuristicOrderKm(anchorSets);
}

// ── Coverage ──────────────────────────────────────────────────────────────────

/**
 * Ray-casting point-in-polygon test. Duplicated from `map-data/geo.ts` for the
 * same reason as the km-per-degree constants: that module drags in the whole
 * neighbourhood catalogue and `server-only`, and this one must stay pure.
 */
function pointInRing(lng: number, lat: number, ring: readonly (readonly [number, number])[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0], yi = ring[i]![1];
    const xj = ring[j]![0], yj = ring[j]![1];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export interface AreaCoverage {
  name: string;
  /** Census population inside the area's polygon. */
  population: number;
  /** Of that, how much lies within `walkKm` of a stop on this route. */
  servedPopulation: number;
  /** `servedPopulation / population`, in [0, 1]. 0 when the area has no population. */
  share: number;
}

export interface CoverageMetrics {
  /** Population within `walkKm` of ANY stop — a UNION, each block counted once. */
  servedPop: number;
  /** Population within `walkKm` of the existing network (whole city). */
  existingNetworkPop: number;
  /** The part of `servedPop` the existing network already reached. */
  overlapPop: number;
  /** `servedPop - overlapPop`: people this line reaches who weren't reached before. */
  netNewPop: number;
  /** Per selected area, the share of its population now within `walkKm` of a stop. */
  areaCoverage: AreaCoverage[];
  /** `min(areaCoverage.share)`, or 1 when no areas were supplied. */
  minAreaCoverage: number;
}

/**
 * A reach test that rejects most blocks without any trigonometry.
 *
 * WHY: the live raster holds ~80,000 Toronto blocks and the existing network
 * ~100+ stops, so the naive double loop is millions of haversines per route —
 * and the council computes metrics four times per run. Almost every block is
 * nowhere near the route, and a degree-box test settles those in two
 * comparisons. The exact circular test still decides every block that survives,
 * so the answer is identical to the naive version.
 */
function makeReachTest(
  stops: readonly MetricStop[],
  km: number,
): (point: readonly [number, number]) => boolean {
  if (stops.length === 0) return () => false;

  const padLng = km / KM_PER_DEG_LNG;
  const padLat = km / KM_PER_DEG_LAT;
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
  for (const s of stops) {
    west = Math.min(west, s.coords[0]);
    east = Math.max(east, s.coords[0]);
    south = Math.min(south, s.coords[1]);
    north = Math.max(north, s.coords[1]);
  }
  west -= padLng; east += padLng; south -= padLat; north += padLat;

  return (point) => {
    const [lng, lat] = point;
    if (lng < west || lng > east || lat < south || lat > north) return false;
    for (const s of stops) if (haversineKm(point as [number, number], s.coords) <= km) return true;
    return false;
  };
}

/**
 * Coverage, computed as a union over blocks.
 *
 * NOTE on `netNewPop`: the report defines it as "servedPop minus population
 * already within 800 m of the existing network". Read literally that subtracts
 * the *whole city's* existing catchment and goes sharply negative, so what it
 * must mean — and what is implemented — is the OVERLAP: the part of this
 * route's own catchment that the existing network already had. Both the
 * overlap and the city-wide existing figure are reported, so a caller can see
 * the difference rather than take the subtraction on faith.
 */
export function computeCoverage(
  stops: readonly MetricStop[],
  population: PopulationSource,
  opts: {
    existingStops?: readonly MetricStop[];
    areas?: readonly SelectedArea[];
    walkKm?: number;
  } = {},
): CoverageMetrics {
  const walkKm = opts.walkKm ?? 0.8;
  const existing = opts.existingStops ?? [];
  const areas = opts.areas ?? [];
  const blocks = population.blocks();
  const isServed = makeReachTest(stops, walkKm);
  const wasServedBefore = makeReachTest(existing, walkKm);

  let servedPop = 0;
  let existingNetworkPop = 0;
  let overlapPop = 0;
  const areaTotals = areas.map(() => 0);
  const areaServed = areas.map(() => 0);

  for (const block of blocks) {
    const [lng, lat] = block.coords;
    const served = isServed(block.coords);
    const wasServed = wasServedBefore(block.coords);
    if (served) servedPop += block.population;
    if (wasServed) existingNetworkPop += block.population;
    if (served && wasServed) overlapPop += block.population;

    for (let i = 0; i < areas.length; i++) {
      if (!pointInRing(lng, lat, areas[i]!.ring)) continue;
      areaTotals[i] = areaTotals[i]! + block.population;
      if (served) areaServed[i] = areaServed[i]! + block.population;
    }
  }

  const areaCoverage: AreaCoverage[] = areas.map((a, i) => ({
    name: a.name,
    population: Math.round(areaTotals[i]!),
    servedPopulation: Math.round(areaServed[i]!),
    share: areaTotals[i]! > 0 ? areaServed[i]! / areaTotals[i]! : 0,
  }));

  return {
    servedPop: Math.round(servedPop),
    existingNetworkPop: Math.round(existingNetworkPop),
    overlapPop: Math.round(overlapPop),
    netNewPop: Math.round(servedPop - overlapPop),
    areaCoverage,
    minAreaCoverage: areaCoverage.length > 0 ? Math.min(...areaCoverage.map((a) => a.share)) : 1,
  };
}

// ── The whole picture ─────────────────────────────────────────────────────────

export interface RouteMetrics {
  stopCount: number;
  mode: TransitMode;
  geometry: GeometryMetrics;
  coverage: CoverageMetrics;
  cost: { costBn: number; perKmBn: number; perStationBn: number };
  /** Shortest path through every selected area, and the route's ratio to it. */
  detour: { throughPathKm: number; detourIndex: number };
  efficiency: {
    /** THE headline number: net new catchment per $B spent. */
    netNewPopPerBn: number;
    /** Reported alongside, for intuition. */
    servedPopPerKm: number;
  };
}

/** Every number in §5 of the report, for one route. Pure. */
export function computeRouteMetrics(input: RouteMetricsInput): RouteMetrics {
  const mode = input.mode ?? "subway";
  const stops = input.stops;
  const geometry = computeGeometry(stops, input.spacing);
  const coverage = computeCoverage(stops, input.population, {
    existingStops: input.existingStops,
    areas: input.areas,
    walkKm: input.walkKm,
  });

  const cost = costBn(geometry.totalKm, stops.length, mode);
  const through = throughPathKm(input.areas ?? []);

  return {
    stopCount: stops.length,
    mode,
    geometry,
    coverage,
    cost: { costBn: cost, perKmBn: MODE_COSTS[mode].perKmBn, perStationBn: MODE_COSTS[mode].perStationBn },
    detour: {
      throughPathKm: through,
      // No areas (or one) means no shortest-through-path is defined; report 1
      // rather than a number that looks like a measurement but isn't.
      detourIndex: through > 0 ? geometry.totalKm / through : 1,
    },
    efficiency: {
      netNewPopPerBn: cost > 0 ? coverage.netNewPop / cost : 0,
      servedPopPerKm: geometry.totalKm > 0 ? coverage.servedPop / geometry.totalKm : 0,
    },
  };
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/**
 * The report's §5 gate thresholds, as defaults. NOT enforced anywhere yet — a
 * later task owns wiring a gate into the council path. Exported here so that
 * task, the eval runner and the baseline summary all read the same numbers.
 */
export const GATE_DEFAULTS = {
  maxSelfIntersections: 0,
  maxReversals: 0,
  maxTurnDeg: 60,
  spacingKm: { minKm: 0.8, maxKm: 1.5 },
  minAreaCoverage: 0.25,
  maxDetourIndex: 1.3,
} as const;

export interface GateResult {
  passed: boolean;
  failures: string[];
}

/** Evaluate a route's metrics against {@link GATE_DEFAULTS}. Reports; gates nothing. */
export function evaluateGate(
  metrics: RouteMetrics,
  thresholds: typeof GATE_DEFAULTS = GATE_DEFAULTS,
): GateResult {
  const failures: string[] = [];
  const { geometry, coverage, detour } = metrics;

  if (geometry.selfIntersections > thresholds.maxSelfIntersections) {
    failures.push(`${geometry.selfIntersections} self-intersection(s)`);
  }
  if (geometry.reversals > thresholds.maxReversals) {
    failures.push(`${geometry.reversals} reversal(s) over 120°`);
  }
  if (geometry.maxTurnDeg > thresholds.maxTurnDeg) {
    failures.push(`worst turn ${geometry.maxTurnDeg.toFixed(1)}° exceeds ${thresholds.maxTurnDeg}°`);
  }
  const spacingBad = geometry.spacingViolations.tooClose + geometry.spacingViolations.tooFar;
  if (spacingBad > 0) {
    failures.push(
      `${spacingBad} stop gap(s) outside ${thresholds.spacingKm.minKm}–${thresholds.spacingKm.maxKm} km`,
    );
  }
  if (coverage.areaCoverage.length > 0 && coverage.minAreaCoverage < thresholds.minAreaCoverage) {
    const worst = coverage.areaCoverage.reduce((a, b) => (a.share <= b.share ? a : b));
    failures.push(`${worst.name} only ${(worst.share * 100).toFixed(0)}% covered`);
  }
  if (detour.detourIndex > thresholds.maxDetourIndex) {
    failures.push(`detour index ${detour.detourIndex.toFixed(2)} exceeds ${thresholds.maxDetourIndex}`);
  }

  return { passed: failures.length === 0, failures };
}
