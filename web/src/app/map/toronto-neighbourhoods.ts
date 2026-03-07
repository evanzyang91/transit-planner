// Simplified Toronto neighbourhood boundaries for demo purposes.
// Coordinates are [longitude, latitude].

function rect(west: number, east: number, south: number, north: number): number[][] {
  return [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
}

export const NEIGHBOURHOOD_ADJACENCY: Record<string, string[]> = {
  "harbourfront":          ["entertainment-district", "downtown-core", "distillery-corktown"],
  "entertainment-district":["harbourfront", "downtown-core", "queen-west", "kensington-market"],
  "downtown-core":         ["harbourfront", "entertainment-district", "distillery-corktown", "kensington-market", "church-wellesley"],
  "distillery-corktown":   ["harbourfront", "downtown-core", "regent-park", "leslieville"],
  "parkdale":              ["queen-west"],
  "queen-west":            ["entertainment-district", "parkdale", "kensington-market", "annex"],
  "kensington-market":     ["entertainment-district", "downtown-core", "queen-west", "church-wellesley", "annex"],
  "church-wellesley":      ["downtown-core", "kensington-market", "regent-park", "rosedale"],
  "regent-park":           ["distillery-corktown", "church-wellesley", "leslieville", "riverdale-danforth"],
  "leslieville":           ["distillery-corktown", "regent-park", "riverdale-danforth"],
  "annex":                 ["queen-west", "kensington-market", "rosedale", "midtown"],
  "rosedale":              ["church-wellesley", "annex", "riverdale-danforth", "midtown"],
  "riverdale-danforth":    ["regent-park", "leslieville", "rosedale"],
  "midtown":               ["annex", "rosedale", "forest-hill", "north-york"],
  "forest-hill":           ["midtown", "north-york"],
  "north-york":            ["midtown", "forest-hill"],
};

export const TORONTO_NEIGHBOURHOODS: GeoJSON.FeatureCollection<GeoJSON.Polygon> = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { id: "harbourfront", name: "Harbourfront" },
      geometry: { type: "Polygon", coordinates: [rect(-79.450, -79.330, 43.618, 43.643)] },
    },
    {
      type: "Feature",
      properties: { id: "entertainment-district", name: "Entertainment District" },
      geometry: { type: "Polygon", coordinates: [rect(-79.450, -79.395, 43.643, 43.660)] },
    },
    {
      type: "Feature",
      properties: { id: "downtown-core", name: "Downtown Core" },
      geometry: { type: "Polygon", coordinates: [rect(-79.395, -79.358, 43.643, 43.660)] },
    },
    {
      type: "Feature",
      properties: { id: "distillery-corktown", name: "Distillery & Corktown" },
      geometry: { type: "Polygon", coordinates: [rect(-79.358, -79.330, 43.643, 43.660)] },
    },
    {
      type: "Feature",
      properties: { id: "parkdale", name: "Parkdale" },
      geometry: { type: "Polygon", coordinates: [rect(-79.490, -79.450, 43.635, 43.673)] },
    },
    {
      type: "Feature",
      properties: { id: "queen-west", name: "Queen West" },
      geometry: { type: "Polygon", coordinates: [rect(-79.450, -79.420, 43.658, 43.673)] },
    },
    {
      type: "Feature",
      properties: { id: "kensington-market", name: "Kensington Market" },
      geometry: { type: "Polygon", coordinates: [rect(-79.420, -79.390, 43.658, 43.673)] },
    },
    {
      type: "Feature",
      properties: { id: "church-wellesley", name: "Church & Wellesley" },
      geometry: { type: "Polygon", coordinates: [rect(-79.390, -79.358, 43.658, 43.673)] },
    },
    {
      type: "Feature",
      properties: { id: "regent-park", name: "Regent Park" },
      geometry: { type: "Polygon", coordinates: [rect(-79.358, -79.330, 43.658, 43.678)] },
    },
    {
      type: "Feature",
      properties: { id: "leslieville", name: "Leslieville" },
      geometry: { type: "Polygon", coordinates: [rect(-79.330, -79.280, 43.653, 43.682)] },
    },
    {
      type: "Feature",
      properties: { id: "annex", name: "The Annex" },
      geometry: { type: "Polygon", coordinates: [rect(-79.425, -79.385, 43.673, 43.692)] },
    },
    {
      type: "Feature",
      properties: { id: "rosedale", name: "Rosedale" },
      geometry: { type: "Polygon", coordinates: [rect(-79.385, -79.353, 43.673, 43.692)] },
    },
    {
      type: "Feature",
      properties: { id: "riverdale-danforth", name: "Riverdale & Danforth" },
      geometry: { type: "Polygon", coordinates: [rect(-79.353, -79.280, 43.675, 43.698)] },
    },
    {
      type: "Feature",
      properties: { id: "midtown", name: "Midtown" },
      geometry: { type: "Polygon", coordinates: [rect(-79.445, -79.385, 43.692, 43.732)] },
    },
    {
      type: "Feature",
      properties: { id: "forest-hill", name: "Forest Hill" },
      geometry: { type: "Polygon", coordinates: [rect(-79.475, -79.445, 43.690, 43.745)] },
    },
    {
      type: "Feature",
      properties: { id: "north-york", name: "North York Centre" },
      geometry: { type: "Polygon", coordinates: [rect(-79.465, -79.370, 43.732, 43.805)] },
    },
  ],
};

/**
 * Multi-source BFS: finds the shortest path from any already-selected
 * neighbourhood to `target`, returning the list of NEW neighbourhood IDs
 * to add (not including already-selected ones, but including target).
 */
export function findNeighbourhoodPath(selected: Set<string>, target: string): string[] {
  if (selected.size === 0) return [target];

  const queue: Array<{ id: string; newNodes: string[] }> = [];
  const visited = new Set<string>(selected);

  for (const id of selected) {
    queue.push({ id, newNodes: [] });
  }

  while (queue.length > 0) {
    const item = queue.shift()!;
    const { id: current, newNodes } = item;

    for (const neighbour of (NEIGHBOURHOOD_ADJACENCY[current] ?? [])) {
      if (neighbour === target) {
        return [...newNodes, target];
      }
      if (!visited.has(neighbour)) {
        visited.add(neighbour);
        queue.push({ id: neighbour, newNodes: [...newNodes, neighbour] });
      }
    }
  }

  // No path found — just add the target by itself
  return [target];
}
