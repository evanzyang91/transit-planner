import "server-only";

/**
 * Pure geometry helpers for the map-data layer. Consolidated here from
 * ai-map-tools.handlers.ts so the tool registry, gap engine, and council brief
 * all share one implementation.
 */

import { TORONTO_NEIGHBOURHOODS } from "~/app/map/toronto-neighbourhoods";

/** Toronto metro bbox [west, south, east, north] — the AI's operating area. */
export const TORONTO_BBOX: [number, number, number, number] = [
  -79.75, 43.55, -79.05, 43.95,
];

export type BBox = [number, number, number, number];

// Degrees → km conversion at Toronto's latitude. A degree of longitude is much
// shorter than a degree of latitude this far north, so they can't be treated
// as equal.
export const KM_PER_DEG_LAT = 110.574;
export const KM_PER_DEG_LNG = 111.32 * Math.cos((43.7 * Math.PI) / 180); // ~80.5 km at 43.7°N

export function inBBox(lng: number, lat: number, bbox: BBox): boolean {
  const [west, south, east, north] = bbox;
  return lng >= west && lng <= east && lat >= south && lat <= north;
}

/**
 * Ray-casting point-in-polygon test.
 * 📖 Learn: shoot a ray from the point; count edge crossings — odd = inside.
 */
export function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!;
    const xj = ring[j]![0]!, yj = ring[j]![1]!;
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Name of the Toronto neighbourhood containing a point, or null. */
export function neighbourhoodAt(lng: number, lat: number): string | null {
  for (const f of TORONTO_NEIGHBOURHOODS.features) {
    const ring = f.geometry.coordinates[0];
    if (ring && pointInRing(lng, lat, ring)) {
      return String(f.properties?.name ?? f.properties?.id ?? "unknown");
    }
  }
  return null;
}

/** The polygon ring for a catalogued neighbourhood, looked up by name or id. */
export function neighbourhoodRing(nameOrId: string): { name: string; ring: [number, number][] } | null {
  const wanted = nameOrId.trim().toLowerCase();
  for (const f of TORONTO_NEIGHBOURHOODS.features) {
    const name = String(f.properties?.name ?? "");
    const id = String(f.properties?.id ?? "");
    if (name.toLowerCase() === wanted || id.toLowerCase() === wanted) {
      const ring = f.geometry.coordinates[0];
      if (ring) return { name: name || id, ring: ring as [number, number][] };
    }
  }
  return null;
}

/** Average-of-vertices centroid for a polygon ring. */
export function ringCentroid(ring: number[][]): [number, number] {
  let lng = 0;
  let lat = 0;
  for (const p of ring) {
    lng += p[0]!;
    lat += p[1]!;
  }
  return [lng / ring.length, lat / ring.length];
}

/**
 * Approximate polygon area in km² via the shoelace formula.
 * 📖 Learn: shoelace formula — polygon area from ordered vertices via cross products.
 */
export function polygonAreaKm2(points: [number, number][]): number {
  let cross = 0;
  for (let i = 0; i < points.length; i++) {
    const [lng1, lat1] = points[i]!;
    const [lng2, lat2] = points[(i + 1) % points.length]!;
    cross += lng1 * lat2 - lng2 * lat1;
  }
  const areaDeg2 = Math.abs(cross) / 2;
  return areaDeg2 * KM_PER_DEG_LAT * KM_PER_DEG_LNG;
}

/**
 * Convex hull of a point set (Andrew's monotone chain, O(n log n)).
 * 📖 Learn: sort points, then build the lower and upper hull with a
 * cross-product "turn direction" test. We use it to turn a cluster of census
 * blocks into a drawable polygon outline — computed, never model-drawn.
 */
export function convexHull(points: [number, number][]): [number, number][] {
  if (points.length <= 3) return [...points];
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

/**
 * Degree box comfortably containing a radius around a point — a cheap,
 * index-friendly SQL pre-filter before the precise circular test in JS.
 * (Moved from council-demand-tools.ts so all census queries share it.)
 */
export function boundingBox(
  [lon, lat]: [number, number],
  radiusKm: number,
): { west: number; south: number; east: number; north: number } {
  const latDeg = radiusKm / 111;
  const lonDeg = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { west: lon - lonDeg, south: lat - latDeg, east: lon + lonDeg, north: lat + latDeg };
}

// ── raster footprint outlining ────────────────────────────────────────────────
/**
 * Cell size for footprint outlining, in km.
 *
 * WHY A FIXED SIZE: an earlier version tried to INFER a lattice step from the
 * data, on the assumption that census blocks sit on a regular ~1 km grid. They
 * do not — `pop_data` holds dissemination-block centroids whose spacing is
 * irregular (observed: 0.000002° between the closest pair, 0.000563° median).
 * Inferring from the minimum gap produced sub-metre cells, so every block
 * became its own island and a 19,836-person gap outlined as a 1 m dot.
 *
 * So the grid is a deliberate RESOLUTION choice, not a property of the data:
 * points are snapped into bins and the union of occupied bins is the footprint.
 *
 * 0.75 km is measured, not guessed. Because only the LARGEST ring is kept, too
 * fine a grid fragments a pocket into disconnected islands and most of its
 * population ends up outside the outline. Containment of a real 139-block
 * Etobicoke pocket, by cell size:
 *   0.20 km -> 24%   0.35 km -> 32%   0.50 km -> 63%   0.75 km -> 99%
 * Coarser than this buys nothing (1.0 km -> 97%) and only blurs the shape.
 */
const CELL_KM = 0.75;

/**
 * Corner-rounding for a closed ring (Chaikin's algorithm).
 *
 * 📖 Learn: Chaikin subdivision — each edge P→Q is replaced by two points at
 * 25% and 75% along it. Repeating converges on a quadratic B-spline, which is
 * why one pass still looks angular and two read as "organic". It only ever cuts
 * corners, so the smoothed ring stays strictly inside the original and can
 * never bulge out into land that had no population.
 */
function chaikin(ring: [number, number][], passes: number): [number, number][] {
  let out = ring;
  for (let p = 0; p < passes; p++) {
    const next: [number, number][] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i]!;
      const b = out[(i + 1) % out.length]!;
      next.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
      next.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
    }
    out = next;
  }
  return out;
}

/** Drop points lying on the straight line between their neighbours. */
function dropCollinear(ring: [number, number][]): [number, number][] {
  if (ring.length < 3) return ring;
  const out: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    const prev = ring[(i - 1 + ring.length) % ring.length]!;
    const cur = ring[i]!;
    const next = ring[(i + 1) % ring.length]!;
    const cross =
      (cur[0] - prev[0]) * (next[1] - prev[1]) - (cur[1] - prev[1]) * (next[0] - prev[0]);
    if (Math.abs(cross) > 1e-12) out.push(cur);
  }
  return out.length >= 3 ? out : ring;
}

/**
 * Outline the ACTUAL footprint of a set of raster census blocks.
 *
 * Replaces convexHull() for service-area artifacts. A convex hull spans
 * everything between the extreme blocks — parks, rail yards, airport lands,
 * open water — and so visually claims territory that contributed nobody to the
 * area's population count. Two pockets with entirely disjoint blocks could even
 * produce overlapping hulls (observed live: "Markland Wood" over "Etobicoke
 * gap"), which reads as double-counting that isn't happening. A cell union
 * covers only cells that are actually members, so disjoint pockets can never
 * produce overlapping outlines.
 *
 * 📖 Learn: boundary extraction by edge cancellation. Each occupied cell emits
 * its 4 edges wound counter-clockwise. Two side-by-side cells emit the SAME
 * shared edge in opposite directions, so that pair annihilates; only edges with
 * no neighbour on the far side survive, and those are exactly the perimeter.
 * Working on integer lattice indices (not floats) makes "same edge" an exact
 * string match rather than an epsilon comparison.
 *
 * Returns a single outer ring; interior holes are discarded (AreaArtifact
 * .polygon is one ring). Returns [] only for empty/degenerate input; the
 * caller keeps its own fallback for that case.
 */
export function cellUnionOutline(
  points: [number, number][],
  smoothPasses = 2,
  cellKm = CELL_KM,
): [number, number][] {
  if (points.length === 0) return [];

  // Square cells in METRES, which means unequal cell sizes in degrees: a degree
  // of longitude is only ~73% of a degree of latitude at Toronto's latitude.
  const stepLng = cellKm / KM_PER_DEG_LNG;
  const stepLat = cellKm / KM_PER_DEG_LAT;

  // GLOBAL lattice origin, not one derived from `points`. Deriving it per call
  // gave every pocket its own misaligned grid, so two pockets holding disjoint
  // blocks could still emit cells that overlap in space — the exact overlap
  // this function was meant to eliminate. Anchoring every call to the same
  // origin makes a given location map to the same cell index every time.
  const [originLng, originLat] = TORONTO_BBOX;

  // Safety valve against an absurd index space (bad input, wrong hemisphere).
  if (
    (Math.max(...points.map((p) => p[0])) - originLng) / stepLng > 2000 ||
    (Math.max(...points.map((p) => p[1])) - originLat) / stepLat > 2000
  ) {
    return [];
  }

  const cells = new Set<string>();
  for (const [lng, lat] of points) {
    cells.add(
      `${Math.round((lng - originLng) / stepLng)},${Math.round((lat - originLat) / stepLat)}`,
    );
  }

  // Directed perimeter edges on the integer corner lattice. A single corner can
  // carry several edges (four cells meet at an interior corner), so edges are
  // keyed by the WHOLE edge — keying by origin alone silently drops some.
  const edges = new Set<string>();
  const addEdge = (a: string, b: string) => {
    const reverse = `${b}>${a}`;
    if (edges.has(reverse)) edges.delete(reverse);
    else edges.add(`${a}>${b}`);
  };
  for (const key of cells) {
    const [i, j] = key.split(",").map(Number) as [number, number];
    // Counter-clockwise winding around the cell.
    addEdge(`${i},${j}`, `${i + 1},${j}`);
    addEdge(`${i + 1},${j}`, `${i + 1},${j + 1}`);
    addEdge(`${i + 1},${j + 1}`, `${i},${j + 1}`);
    addEdge(`${i},${j + 1}`, `${i},${j}`);
  }
  if (edges.size < 4) return [];

  // Chain surviving edges into rings through an adjacency multimap, keeping the
  // longest ring (the outer boundary).
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const [a, b] = e.split(">") as [string, string];
    const list = outgoing.get(a);
    if (list) list.push(b);
    else outgoing.set(a, [b]);
  }
  let best: string[] = [];
  while (outgoing.size > 0) {
    const start = outgoing.keys().next().value!;
    const ring: string[] = [];
    let cur = start;
    for (;;) {
      const nexts = outgoing.get(cur);
      if (!nexts || nexts.length === 0) break;
      const next = nexts.pop()!;
      if (nexts.length === 0) outgoing.delete(cur);
      ring.push(cur);
      if (next === start) break;
      cur = next;
    }
    if (ring.length > best.length) best = ring;
  }
  if (best.length < 3) return [];

  // Corner index c sits at a cell edge — half a step below cell centre c.
  const ring: [number, number][] = best.map((k) => {
    const [i, j] = k.split(",").map(Number) as [number, number];
    return [originLng + (i - 0.5) * stepLng, originLat + (j - 0.5) * stepLat];
  });

  return chaikin(dropCollinear(ring), smoothPasses);
}
