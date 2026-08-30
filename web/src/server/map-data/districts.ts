import "server-only";

/**
 * Toronto's six former boroughs as COARSE polygons (5–8 vertices each).
 *
 * Why this exists: the neighbourhood catalogue covers only ~16 central areas,
 * and the population-centre list holds GTA *municipalities* — so a point in
 * Scarborough used to be named "Markham area" (observed live), making the AI
 * sound like it thinks Scarborough isn't Toronto. District-level naming fixes
 * that without hand-waving street-level precision we don't have.
 *
 * ⚠️ Boundaries are deliberately approximate (follow the well-known borders:
 * Victoria Park, Steeles, the Humber, Etobicoke Creek, the Rouge). Fine for
 * naming and district-scale shading; do NOT use for parcel-level queries.
 * Fine-grained naming lives in city-neighbourhoods.ts (official 158-hood
 * dataset); these rings remain for borough-level asks ("shade Scarborough").
 */

export interface District {
  name: string;
  /** [lng, lat] ring, not closed (first point ≠ last point). */
  ring: [number, number][];
}

export const TORONTO_DISTRICTS: District[] = [
  {
    // Victoria Park (W) · Steeles (N) · Rouge River (E) · lakeshore (S)
    name: "Scarborough",
    ring: [
      [-79.312, 43.668],
      [-79.288, 43.815],
      [-79.17, 43.855],
      [-79.115, 43.795],
      [-79.155, 43.752],
      [-79.23, 43.7],
    ],
  },
  {
    // Humber (W) · Steeles (N) · Victoria Park (E) · ~Eglinton/valley line (S)
    name: "North York",
    ring: [
      [-79.55, 43.744],
      [-79.51, 43.794],
      [-79.288, 43.815],
      [-79.302, 43.702],
      [-79.4, 43.7],
      [-79.506, 43.71],
    ],
  },
  {
    // Etobicoke Creek (W) · Steeles (N) · Humber River (E) · lakeshore (S)
    name: "Etobicoke",
    ring: [
      [-79.543, 43.582],
      [-79.615, 43.63],
      [-79.639, 43.75],
      [-79.55, 43.744],
      [-79.506, 43.71],
      [-79.472, 43.63],
    ],
  },
  {
    // Pocket between the Don Valley and Victoria Park around Danforth/O'Connor.
    name: "East York",
    ring: [
      [-79.36, 43.685],
      [-79.345, 43.72],
      [-79.302, 43.702],
      [-79.312, 43.668],
      [-79.34, 43.67],
    ],
  },
  {
    // Weston / Mount Dennis wedge between Old Toronto and North York.
    name: "York",
    ring: [
      [-79.5, 43.665],
      [-79.52, 43.705],
      [-79.44, 43.71],
      [-79.415, 43.675],
    ],
  },
  {
    // The pre-amalgamation core: lakeshore up to roughly St. Clair.
    name: "Old Toronto",
    ring: [
      [-79.472, 43.63],
      [-79.5, 43.665],
      [-79.415, 43.675],
      [-79.36, 43.685],
      [-79.34, 43.67],
      [-79.312, 43.668],
      [-79.28, 43.64],
    ],
  },
];

// Same ray-casting point-in-polygon as geo.ts (kept local to avoid a cycle).
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

/** Which former borough contains this point (null if outside all of them). */
export function districtAt(lng: number, lat: number): string | null {
  for (const d of TORONTO_DISTRICTS) {
    if (inRing(lng, lat, d.ring)) return d.name;
  }
  return null;
}

/** Case-insensitive district lookup by name (for show_area). */
export function districtRing(name: string): District | null {
  const wanted = name.trim().toLowerCase();
  return TORONTO_DISTRICTS.find((d) => d.name.toLowerCase() === wanted) ?? null;
}
