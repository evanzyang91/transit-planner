import type { Route } from "~/app/map/transit-data";

export function pointInRing(px: number, py: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!, yi = ring[i]![1]!;
    const xj = ring[j]![0]!, yj = ring[j]![1]!;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInGeometry(pt: [number, number], geom: GeoJSON.Geometry): boolean {
  if (geom.type === "Polygon") {
    return pointInRing(pt[0], pt[1], (geom.coordinates as number[][][])[0]!);
  }
  if (geom.type === "MultiPolygon") {
    return (geom.coordinates as number[][][][]).some((poly) => pointInRing(pt[0], pt[1], poly[0]!));
  }
  return false;
}

export function geomBBox(geom: GeoJSON.Geometry): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  function walk(c: unknown) {
    if (Array.isArray(c) && typeof c[0] === "number") {
      if (c[0]! < minX) minX = c[0]!;
      if (c[1]! < minY) minY = c[1]!;
      if (c[0]! > maxX) maxX = c[0]!;
      if (c[1]! > maxY) maxY = c[1]!;
    } else if (Array.isArray(c)) { c.forEach(walk); }
  }
  walk((geom as unknown as { coordinates: unknown }).coordinates);
  return [minX, minY, maxX, maxY];
}

export function firstCoord(geom: GeoJSON.Geometry): [number, number] | null {
  let result: [number, number] | null = null;
  function walk(c: unknown): boolean {
    if (Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number") {
      result = [c[0] as number, c[1] as number]; return true;
    }
    if (Array.isArray(c)) { for (const x of c) if (walk(x)) return true; }
    return false;
  }
  walk((geom as unknown as { coordinates: unknown }).coordinates);
  return result;
}


/** Catmull-Rom spline interpolation for a single axis */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t
  );
}

/** Insert smooth curve points between each pair of coordinates using Catmull-Rom spline */
function smoothCoords(coords: [number, number][], steps = 12): [number, number][] {
  if (coords.length < 2) return coords;
  const result: [number, number][] = [];
  for (let i = 0; i < coords.length - 1; i++) {
    const p0 = coords[Math.max(0, i - 1)]!;
    const p1 = coords[i]!;
    const p2 = coords[i + 1]!;
    const p3 = coords[Math.min(coords.length - 1, i + 2)]!;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      result.push([catmullRom(p0[0], p1[0], p2[0], p3[0], t), catmullRom(p0[1], p1[1], p2[1], p3[1], t)]);
    }
  }
  result.push(coords[coords.length - 1]!);
  return result;
}

export function routeToGeoJSON(route: Route): GeoJSON.Feature<GeoJSON.LineString> {
  const raw = route.shape ?? route.stops.map((s) => s.coords);
  return {
    type: "Feature",
    properties: { id: route.id },
    geometry: { type: "LineString", coordinates: smoothCoords(raw) },
  };
}

export function stopsToGeoJSON(route: Route): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const stops = route.stops;
  return {
    type: "FeatureCollection",
    features: stops.map((s, i) => {
      // Compute average direction vector from neighbouring stops
      const prev = i > 0 ? stops[i - 1]!.coords : null;
      const next = i < stops.length - 1 ? stops[i + 1]!.coords : null;
      let dx = 0, dy = 0;
      if (prev) { dx += s.coords[0] - prev[0]; dy += s.coords[1] - prev[1]; }
      if (next) { dx += next[0] - s.coords[0]; dy += next[1] - s.coords[1]; }
      // 📖 Learn: longitude diff (dx) maps to screen horizontal; latitude diff (dy) maps to screen vertical.
      // If the line is more vertical (|dy| > |dx|), put the label to the right instead of below.
      const labelAnchor = (prev || next) && Math.abs(dy) > Math.abs(dx) ? "left" : "top";
      return {
        type: "Feature",
        // stopId is what click/drag handlers address the stop by — `name` here
        // is for the label layer only. Two stops on one route can share a name.
        properties: { stopId: s.id, name: s.name, routeId: route.id, color: route.color, labelAnchor },
        geometry: { type: "Point", coordinates: s.coords },
      };
    }),
  };
}

type Coord = [number, number];

function closestSegment(p: Coord, a: Coord, b: Coord): { t: number; dist2: number } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { t: 0, dist2: (p[0]-a[0])**2 + (p[1]-a[1])**2 };
  const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx + (p[1]-a[1])*dy) / len2));
  return { t, dist2: (p[0]-(a[0]+t*dx))**2 + (p[1]-(a[1]+t*dy))**2 };
}

function linearPos(p: Coord, coords: Coord[]): number {
  let bestPos = 0, bestDist2 = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const { t, dist2 } = closestSegment(p, coords[i]!, coords[i+1]!);
    if (dist2 < bestDist2) { bestDist2 = dist2; bestPos = i + t; }
  }
  return bestPos;
}

function lerp2(coords: Coord[], pos: number): Coord {
  const i = Math.min(Math.floor(pos), coords.length - 2);
  const t = pos - i, a = coords[i]!, b = coords[i+1]!;
  return [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])];
}

function sliceLine(coords: Coord[], pos0: number, pos1: number): Coord[] {
  const seg: Coord[] = [lerp2(coords, pos0)];
  const from = Math.floor(pos0) + 1;
  const to = Math.min(Math.ceil(pos1), coords.length - 1);
  for (let i = from; i < to; i++) seg.push(coords[i]!);
  seg.push(lerp2(coords, pos1));
  return seg;
}

/**
 * Given portal coords and the full smoothed route coords, returns underground
 * sub-segments. Portals alternate: first toggles underground ON, second OFF, etc.
 */
export function computeUndergroundSegments(portalCoords: Coord[], routeCoords: Coord[]): Coord[][] {
  if (portalCoords.length === 0 || routeCoords.length < 2) return [];
  const positions = portalCoords.map(p => linearPos(p, routeCoords)).sort((a, b) => a - b);
  const result: Coord[][] = [];
  for (let i = 0; i < positions.length; i += 2) {
    const start = positions[i]!;
    const end = i + 1 < positions.length ? positions[i+1]! : routeCoords.length - 1;
    result.push(sliceLine(routeCoords, start, end));
  }
  return result;
}

/** Snap a coordinate to the nearest point on the route's smoothed shape */
export function snapToShape(p: Coord, routeCoords: Coord[]): Coord {
  return lerp2(routeCoords, linearPos(p, routeCoords));
}

/**
 * Extract the sub-segment of a smoothed route polyline that lies between
 * two stop coordinates, preserving all intermediate curve waypoints.
 * Falls back to a straight 2-point segment if the shape is too short.
 */
export function sliceShapeBetween(from: Coord, to: Coord, shape: Coord[]): Coord[] {
  if (shape.length < 2) return [from, to];
  const p0 = linearPos(from, shape);
  const p1 = linearPos(to,   shape);
  if (Math.abs(p0 - p1) < 0.001) return [from, to];
  const [a, b] = p0 <= p1 ? [p0, p1] : [p1, p0];
  const slice = sliceLine(shape, a, b);
  return p0 <= p1 ? slice : [...slice].reverse();
}

export function portalsToGeoJSON(route: Route): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: "FeatureCollection",
    features: (route.portals ?? []).map((portal, i) => ({
      type: "Feature",
      properties: { routeId: route.id, index: i },
      geometry: { type: "Point", coordinates: portal.coords },
    })),
  };
}

export function undergroundToGeoJSON(route: Route): GeoJSON.Feature<GeoJSON.MultiLineString> {
  const shape = route.shape ?? route.stops.map(s => s.coords);
  const smoothed = shape.length >= 2 ? (routeToGeoJSON(route).geometry.coordinates as Coord[]) : [];
  const segments = computeUndergroundSegments((route.portals ?? []).map(p => p.coords), smoothed);
  return {
    type: "Feature",
    properties: { id: route.id },
    geometry: { type: "MultiLineString", coordinates: segments },
  };
}
