import "server-only";

/**
 * The City of Toronto's official 158 social-planning neighbourhoods.
 *
 * Source: City of Toronto Open Data "Neighbourhoods" dataset (Open Government
 * Licence – Toronto), WGS84, simplified offline with Douglas–Peucker (~40 m
 * tolerance, largest outer ring per neighbourhood) from 2.1 MB down to ~65 KB.
 * Plenty of precision for naming a point and shading an area; not for
 * parcel-level work.
 *
 * This supersedes the coarse borough rings in districts.ts for NAMING
 * (districts stay for borough-level questions like "shade Scarborough").
 */

import RAW from "./toronto-neighbourhoods.json";

export interface CityNeighbourhood {
  name: string;
  /** [lng, lat] open ring (first point ≠ last point). */
  ring: [number, number][];
  /** Precomputed [west, south, east, north] for the cheap pre-test. */
  bbox: [number, number, number, number];
}

// 📖 Learn: a bbox pre-index — point-in-polygon is O(vertices), so we first
// reject candidates whose bounding box doesn't contain the point (a few
// comparisons). With 158 polygons this turns "158 ray-casts" into "~1–3".
const HOODS: CityNeighbourhood[] = (RAW as Array<{ name: string; ring: [number, number][] }>).map(
  (h) => {
    const lngs = h.ring.map((p) => p[0]);
    const lats = h.ring.map((p) => p[1]);
    return {
      name: h.name,
      ring: h.ring,
      bbox: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)],
    };
  },
);

function inRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Official neighbourhood containing this point (null if outside the city). */
export function cityNeighbourhoodAt(lng: number, lat: number): string | null {
  for (const h of HOODS) {
    const [w, s, e, n] = h.bbox;
    if (lng < w || lng > e || lat < s || lat > n) continue;
    if (inRing(lng, lat, h.ring)) return h.name;
  }
  return null;
}

/**
 * Look a neighbourhood up by name, forgivingly: exact match first, then a
 * unique prefix/substring ("Woburn" → "Woburn North" only if unambiguous).
 * Ambiguous or unknown → null; use suggestCityNeighbourhoods for the error.
 */
export function cityNeighbourhoodRing(name: string): CityNeighbourhood | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const exact = HOODS.find((h) => h.name.toLowerCase() === wanted);
  if (exact) return exact;
  const partial = HOODS.filter((h) => h.name.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0]! : null;
}

/** Closest name matches, for show_area rejection messages. */
export function suggestCityNeighbourhoods(name: string, limit = 5): string[] {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return [];
  const scored = HOODS.map((h) => {
    const lower = h.name.toLowerCase();
    // Cheap relevance: substring hit beats shared-prefix length.
    const score = lower.includes(wanted) ? 100 - lower.length : sharedPrefix(lower, wanted);
    return { name: h.name, score };
  }).filter((s) => s.score > 2);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.name);
}

function sharedPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
