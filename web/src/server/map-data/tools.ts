import "server-only";

/**
 * THE tool registry — every AI surface (map assistant, council planners,
 * council critics) draws its tools from here, and every tool queries the same
 * data layer (live network + census raster + shared ridership model).
 *
 * The grounding contract (hybrid geometry policy, agreed with the user):
 *  • READ tools return measured facts, with compact results (no polygon dumps
 *    into the context window). Area geometry is stored server-side in the
 *    request's ArtifactStore under an id.
 *  • The model can NOT freehand-draw area polygons. It cites an artifact id
 *    via `show_area` and the server resolves the real geometry.
 *  • Pins/corridors may use model coordinates, but every point is validated
 *    (city bbox + inhabited land) and corridors are road-snapped server-side.
 *
 * 📖 Learn: this "artifact/reference" pattern is how you make hallucination
 * structurally impossible for a class of outputs — the model chooses among
 * server-computed options instead of generating free-form values.
 */

import { haversineKm } from "~/app/map/geo-utils";
import { POPULATION_CENTERS } from "~/app/map/population-centers";
import { snapToRoads } from "~/lib/road-snap";
import {
  gravityDailyBoardings,
  DEFAULT_WALK_RADIUS_KM,
  DEFAULT_HEADWAY_MIN,
} from "~/lib/ridership-model";
import type { ToolDefinition } from "../ai-provider";
import {
  TORONTO_BBOX,
  inBBox,
  neighbourhoodAt,
  neighbourhoodRing,
  type BBox,
} from "./geo";
import { districtAt, districtRing, TORONTO_DISTRICTS } from "./districts";
import {
  cityNeighbourhoodAt,
  cityNeighbourhoodRing,
  suggestCityNeighbourhoods,
} from "./city-neighbourhoods";
import { getTorontoRaster, populationInRadius, densestBlocks, catchmentPopulation, populationServedByNetwork } from "./census";
import { rankServiceAreas, DEFAULT_GAP_THRESHOLD_KM, type AreaArtifact, type RankOrder } from "./gaps";
import type { LiveNetwork } from "./network";

// ── Per-request context ───────────────────────────────────────────────────────

/**
 * Holds the geometry the READ tools computed this request, keyed by id, so
 * `show_area` can resolve an id to a real polygon. Never outlives the request.
 */
export class ArtifactStore {
  private areas = new Map<string, AreaArtifact>();

  remember(areas: AreaArtifact[]): void {
    for (const a of areas) this.areas.set(a.id, a);
  }
  get(id: string): AreaArtifact | undefined {
    return this.areas.get(id.trim().toLowerCase());
  }
  get knownIds(): string[] {
    return [...this.areas.keys()];
  }
}

export interface ToolContext {
  network: LiveNetwork;
  artifacts: ArtifactStore;
  /**
   * Per-request system prompt override. The map assistant's prompt embeds
   * live-network stats, so it must be rebuilt every turn — it can't live on
   * the provider's stored assistant (which is created once per conversation).
   */
  systemPrompt?: string;
}

// ── Small shared coercions ────────────────────────────────────────────────────

function asPoint(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const lng = Number(raw[0]);
  const lat = Number(raw[1]);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

function asBBox(raw: unknown): BBox | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const nums = raw.slice(0, 4).map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums as BBox;
}

/**
 * "Is this a place people live?" — raster-grounded, replacing the old
 * <8-km-from-a-population-centre heuristic (which passed for spots well out
 * in the lake near downtown). Census blocks only exist where people live, so
 * zero population within 1 km ⇒ water / empty land.
 */
async function isInhabited(point: [number, number]): Promise<boolean | null> {
  const raster = await getTorontoRaster();
  if (!raster) return null; // unknown — callers should not hard-fail on this
  return raster.grid.within(point, 1.0).some((b) => b.population > 0);
}

// ── READ tool definitions ─────────────────────────────────────────────────────

const POINT_SCHEMA = {
  type: "array",
  items: { type: "number" },
  minItems: 2,
  maxItems: 2,
  description: "[longitude, latitude] (Toronto: lon -79.75..-79.05, lat 43.55..43.95)",
};

export const RANK_SERVICE_AREAS_TOOL: ToolDefinition = {
  name: "rank_service_areas",
  description:
    "Rank REAL pockets of Toronto by how the current network serves their census population. " +
    "order='least_served' → coverage gaps (people far from every stop), worst first, ids gap_1… " +
    "order='best_served' → strongest-coverage pockets (most people close to stops), ids served_1… " +
    "Each result carries measured population and an id you can shade with show_area — " +
    "never guess where service is good or bad.",
  inputSchema: {
    type: "object",
    properties: {
      order: {
        type: "string",
        enum: ["least_served", "best_served"],
        description: "Which end of the service spectrum to rank (default least_served).",
      },
      bbox: {
        type: "array",
        items: { type: "number" },
        minItems: 4,
        maxItems: 4,
        description: "Optional [west, south, east, north] to restrict the scan.",
      },
      thresholdKm: {
        type: "number",
        description: `Walk-distance threshold in km separating served from unserved (default ${DEFAULT_GAP_THRESHOLD_KM}).`,
      },
    },
  },
};

export const QUERY_POPULATION_TOOL: ToolDefinition = {
  name: "query_population",
  description:
    "Look up real census population around a point: total in the radius, the densest " +
    "blocks (exact coordinates you can anchor a stop to), and the nearest stops of the " +
    "current network (for transfers / spacing rules). Call before placing or judging a stop.",
  inputSchema: {
    type: "object",
    properties: {
      near: POINT_SCHEMA,
      radiusKm: {
        type: "number",
        description: "Search radius in km (default 1.5). ~0.8 checks one stop, ~3 scans a corridor.",
      },
    },
    required: ["near"],
  },
};

export const ESTIMATE_RIDERSHIP_TOOL: ToolDefinition = {
  name: "estimate_ridership",
  description:
    "Estimate daily boardings for a NEW stop at a point using the app's own gravity " +
    "model (identical to the UI's forecast). Use to compare candidate stops on " +
    "ridership, not just raw population.",
  inputSchema: {
    type: "object",
    properties: {
      stop: POINT_SCHEMA,
      mode: {
        type: "string",
        enum: ["subway", "lrt", "go_train", "streetcar", "bus"],
        description: "Transit mode (default subway). Higher modes attract more riders.",
      },
      headwayMin: { type: "number", description: "Minutes between vehicles (default 10)." },
      walkRadiusKm: { type: "number", description: "Walk-shed radius in km (default 0.8)." },
    },
    required: ["stop"],
  },
};

export const QUERY_NETWORK_TOOL: ToolDefinition = {
  name: "query_network",
  description:
    "Inspect the CURRENT network (including user-drawn lines) before making claims: " +
    "stops_in_bbox, routes_in_bbox, or nearest_stop to a point.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["stops_in_bbox", "routes_in_bbox", "nearest_stop"] },
      bbox: { type: "array", items: { type: "number" } },
      point: { type: "array", items: { type: "number" } },
    },
    required: ["kind"],
  },
};

export const DESCRIBE_LOCATION_TOOL: ToolDefinition = {
  name: "describe_location",
  description:
    "Ground yourself at a point BEFORE referencing it: neighbourhood (if catalogued), " +
    "nearest stop + distance, census population within 1 km, and a raster-grounded " +
    "likelyInhabited flag. If likelyInhabited is false the point is water or empty land.",
  inputSchema: {
    type: "object",
    properties: { point: POINT_SCHEMA },
    required: ["point"],
  },
};

export const NETWORK_COVERAGE_TOOL: ToolDefinition = {
  name: "network_coverage",
  description:
    "Measure what share of Toronto's census population lives within walking distance " +
    "(default 800 m) of any stop in the current network. Use for any 'how many people " +
    "does my network reach' claim.",
  inputSchema: {
    type: "object",
    properties: {
      walkKm: { type: "number", description: "Walking distance in km (default 0.8)." },
    },
  },
};

export const READ_TOOLS: ToolDefinition[] = [
  RANK_SERVICE_AREAS_TOOL,
  QUERY_POPULATION_TOOL,
  ESTIMATE_RIDERSHIP_TOOL,
  QUERY_NETWORK_TOOL,
  DESCRIBE_LOCATION_TOOL,
  NETWORK_COVERAGE_TOOL,
];

// ── WRITE tool definitions (hybrid geometry policy) ───────────────────────────

export const SHOW_AREA_TOOL: ToolDefinition = {
  name: "show_area",
  description:
    "Shade a REAL area on the map by reference — an artifact id returned by " +
    "rank_service_areas this conversation (gap_1, served_2, …), or a catalogued " +
    "neighbourhood/district name. The server supplies the exact polygon; you " +
    "cannot draw one yourself. Always explain the shaded area in your text.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string", enum: ["artifact", "neighbourhood"] },
      id: {
        type: "string",
        description:
          "An artifact id like 'gap_1' or 'served_2', or a name like 'Leaside' or 'Scarborough'.",
      },
      label: { type: "string", description: "Short label override (defaults to the area's name)." },
      severity: { type: "string", enum: ["info", "warning", "critical"] },
    },
    required: ["source", "id"],
  },
};

export const DRAW_CORRIDOR_TOOL: ToolDefinition = {
  name: "draw_corridor",
  description:
    "Draw a proposed transit corridor between two points. Fetch REAL endpoint " +
    "coordinates first (describe_location / query_network / query_population) — " +
    "the server validates both endpoints and snaps the line to the road network.",
  inputSchema: {
    type: "object",
    properties: {
      from: POINT_SCHEMA,
      to: POINT_SCHEMA,
      label: { type: "string" },
      mode: { type: "string", enum: ["subway", "lrt", "streetcar", "bus", "rail"] },
    },
    required: ["from", "to", "label"],
  },
};

export const DROP_PIN_TOOL: ToolDefinition = {
  name: "drop_pin",
  description: "Mark a specific stop, intersection, or point of interest on the map.",
  inputSchema: {
    type: "object",
    properties: {
      lat: { type: "number" },
      lng: { type: "number" },
      note: { type: "string" },
      icon: { type: "string", enum: ["warning", "info", "gap", "hub"] },
    },
    required: ["lat", "lng", "note"],
  },
};

export const FLY_TO_TOOL: ToolDefinition = {
  name: "fly_to",
  description: "Move the map camera to show an area before highlighting findings.",
  inputSchema: {
    type: "object",
    properties: {
      bbox: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
      reason: { type: "string" },
    },
    required: ["bbox"],
  },
};

export const WRITE_TOOLS: ToolDefinition[] = [
  SHOW_AREA_TOOL,
  DRAW_CORRIDOR_TOOL,
  DROP_PIN_TOOL,
  FLY_TO_TOOL,
];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

/** The full map-assistant toolset. */
export const MAP_TOOLS: ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS];

// ── READ tool execution ───────────────────────────────────────────────────────

async function runRankServiceAreas(args: Record<string, unknown>, ctx: ToolContext) {
  const order: RankOrder = args.order === "best_served" ? "best_served" : "least_served";
  const bbox = asBBox(args.bbox) ?? undefined;
  const raw = Number(args.thresholdKm ?? args.minStopKm); // minStopKm = legacy alias
  const threshold = Number.isFinite(raw) && raw > 0 ? Math.min(5, raw) : DEFAULT_GAP_THRESHOLD_KM;

  const areas = await rankServiceAreas(ctx.network, order, threshold, bbox);
  ctx.artifacts.remember(areas);

  const raster = await getTorontoRaster();
  if (!raster) {
    return { error: "Census data unavailable — cannot rank service areas. Do NOT claim any; say the data source is down." };
  }
  return {
    order,
    count: areas.length,
    thresholdKm: threshold,
    note: "To shade an area on the map call show_area with its id.",
    areas: areas.map((a) => ({
      id: a.id,
      name: a.name,
      population: a.population,
      // For gaps this is how far the worst block is from transit; for served
      // pockets, how close the best block is.
      seedStopKm: a.seedStopKm,
      nearestStop: a.nearestStop,
      ...(order === "best_served" ? { stopsInside: a.stopsInside } : {}),
      centroid: a.centroid,
    })),
  };
}

async function runQueryPopulation(args: Record<string, unknown>, ctx: ToolContext) {
  const near = asPoint(args.near);
  if (!near) return { error: "query_population requires `near` as [longitude, latitude]." };
  const radiusKm = Math.min(5, Math.max(0.3, typeof args.radiusKm === "number" ? args.radiusKm : 1.5));

  const nearestStops = ctx.network.grid
    .within(near, radiusKm)
    .map((s) => ({ name: s.name, route: s.route, distanceM: Math.round(haversineKm(near, s.coords) * 1000) }))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, 6);

  const pop = await populationInRadius(near, radiusKm);
  const densest = await densestBlocks(near, radiusKm, 8);
  if (!pop || !densest) {
    return {
      center: near,
      radiusKm,
      nearestStops,
      error: "Population data unavailable. Rely on nearby stops only; do not invent population figures.",
    };
  }
  return {
    center: near,
    radiusKm,
    totalPopulation: pop.population,
    blockCount: pop.blockCount,
    densestPoints: densest,
    nearestStops,
  };
}

async function runEstimateRidership(args: Record<string, unknown>) {
  const stop = asPoint(args.stop);
  if (!stop) return { error: "estimate_ridership requires `stop` as [longitude, latitude]." };
  const mode = typeof args.mode === "string" ? args.mode : "subway";
  const headwayMin = Math.min(60, Math.max(1, typeof args.headwayMin === "number" ? args.headwayMin : DEFAULT_HEADWAY_MIN));
  const walkRadiusKm = Math.min(2, Math.max(0.3, typeof args.walkRadiusKm === "number" ? args.walkRadiusKm : DEFAULT_WALK_RADIUS_KM));

  const catchment = await catchmentPopulation(stop, walkRadiusKm);
  if (catchment === null) {
    return { error: "Population data unavailable — cannot estimate boardings. Do not invent a figure." };
  }
  return {
    stop,
    mode,
    headwayMin,
    walkRadiusKm,
    catchmentPopulation: catchment,
    estimatedDailyBoardings: gravityDailyBoardings(catchment, headwayMin, mode),
    method: "gravity (catchment population × frequency × mode ÷ 365) — same model as the app UI",
  };
}

function runQueryNetwork(args: Record<string, unknown>, ctx: ToolContext) {
  const kind = args.kind;

  if (kind === "nearest_stop") {
    const point = asPoint(args.point);
    if (!point) return { error: "point [lng, lat] required for nearest_stop" };
    const best = ctx.network.grid.nearest(point, 50);
    return best
      ? { name: best.item.name, route: best.item.route, coords: best.item.coords, km: +best.km.toFixed(2) }
      : { error: "no stops found" };
  }

  const bbox = asBBox(args.bbox) ?? TORONTO_BBOX;

  if (kind === "stops_in_bbox") {
    const stops = ctx.network.stops.filter((s) => inBBox(s.coords[0], s.coords[1], bbox));
    return {
      count: stops.length,
      stops: stops.slice(0, 50).map((s) => ({ name: s.name, route: s.route, coords: s.coords })),
    };
  }

  if (kind === "routes_in_bbox") {
    const routes = ctx.network.routes
      .filter((r) => r.stops.some((s) => inBBox(s.coords[0], s.coords[1], bbox)))
      .map((r) => ({ id: r.id, name: r.name, type: r.type, stopCount: r.stops.length }));
    return { count: routes.length, routes: routes.slice(0, 30) };
  }

  return { error: `unknown kind: ${String(kind)}` };
}

async function runDescribeLocation(args: Record<string, unknown>, ctx: ToolContext) {
  const point = asPoint(args.point);
  if (!point) return { error: "point [lng, lat] required" };

  const stop = ctx.network.grid.nearest(point, 50);
  const pop = await populationInRadius(point, 1.0);
  const inhabited = await isInhabited(point);

  let center: { name: string; km: number; population: number } | null = null;
  for (const c of POPULATION_CENTERS) {
    const km = haversineKm(point, [c.lng, c.lat]);
    if (!center || km < center.km) center = { name: c.name, km, population: c.population };
  }

  return {
    point,
    // Official City of Toronto neighbourhood (158 city-wide), falling back to
    // the legacy hand-drawn downtown catalogue for anything the ring
    // simplification clipped at the edges.
    neighbourhood: cityNeighbourhoodAt(point[0], point[1]) ?? neighbourhoodAt(point[0], point[1]),
    // Former borough (Scarborough, North York, Etobicoke, …) — all Toronto.
    district: districtAt(point[0], point[1]),
    nearestStop: stop ? { name: stop.item.name, route: stop.item.route, km: +stop.km.toFixed(2) } : null,
    populationWithin1Km: pop?.population ?? null,
    nearestPopulationCenter: center
      ? { name: center.name, km: +center.km.toFixed(2), population: center.population }
      : null,
    // null = census source down (unknown) — distinct from false (real water/empty land).
    likelyInhabited: inhabited,
  };
}

async function runNetworkCoverage(args: Record<string, unknown>, ctx: ToolContext) {
  const walkKm = Math.min(2, Math.max(0.2, typeof args.walkKm === "number" ? args.walkKm : 0.8));
  const served = await populationServedByNetwork(ctx.network, walkKm);
  if (!served) return { error: "Census data unavailable — cannot measure coverage. Do not invent a percentage." };
  return {
    walkKm,
    servedPopulation: served.servedPopulation,
    totalPopulation: served.totalPopulation,
    pctPopulationServed: served.pct,
    routeCount: ctx.network.stats.routeCount,
    stopCount: ctx.network.stats.stopCount,
    totalKm: ctx.network.stats.totalKm,
  };
}

/** Execute any READ tool by name. Errors are returned as data (fed back to the model). */
export async function runReadTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    // find_coverage_gaps = legacy alias (equivalent to order:"least_served").
    case "find_coverage_gaps":
    case "rank_service_areas": return runRankServiceAreas(args, ctx);
    case "query_population": return runQueryPopulation(args, ctx);
    case "estimate_ridership": return runEstimateRidership(args);
    case "query_network": return runQueryNetwork(args, ctx);
    case "describe_location": return runDescribeLocation(args, ctx);
    case "network_coverage": return runNetworkCoverage(args, ctx);
    default: return { error: `unknown read tool: ${name}` };
  }
}

// ── WRITE tool resolution ─────────────────────────────────────────────────────

/**
 * Outcome of resolving a write tool call:
 *  • rendered — emit `clientName` + `clientArgs` to the browser as a tool_call
 *    event AND acknowledge to the model.
 *  • rejected — nothing is drawn; `error` goes back to the model as the
 *    tool_result so it can correct itself (instead of silently believing it drew).
 */
export type WriteResolution =
  | { status: "rendered"; clientName: string; clientArgs: Record<string, unknown> }
  | { status: "rejected"; error: string };

const SEVERITY_COLOR: Record<string, string> = {
  critical: "red",
  warning: "amber",
  info: "sky",
};

async function resolveShowArea(args: Record<string, unknown>, ctx: ToolContext): Promise<WriteResolution> {
  const source = args.source;
  const id = typeof args.id === "string" ? args.id : "";
  const severity = typeof args.severity === "string" ? args.severity : "warning";
  const label = typeof args.label === "string" && args.label ? args.label : undefined;

  // "gap"/"served" accepted as legacy aliases for "artifact".
  if (source === "artifact" || source === "gap" || source === "served") {
    const area = ctx.artifacts.get(id);
    if (!area) {
      const known = ctx.artifacts.knownIds;
      return {
        status: "rejected",
        error:
          known.length > 0
            ? `Unknown artifact id '${id}'. Known ids from this conversation: ${known.join(", ")}.`
            : `No areas computed yet — call rank_service_areas first, then cite one of its ids.`,
      };
    }
    const defaultLabel =
      area.kind === "gap"
        ? `${area.name} — ${area.population.toLocaleString()} people up to ${area.seedStopKm} km from transit`
        : `${area.name} — ${area.population.toLocaleString()} people well served (${area.stopsInside} stops)`;
    return {
      status: "rendered",
      clientName: "highlight_area",
      clientArgs: {
        polygon: area.polygon,
        label: label ?? defaultLabel,
        color: SEVERITY_COLOR[severity] ?? (area.kind === "gap" ? "amber" : "sky"),
        severity,
        source: area.kind,
        areaId: area.id,
      },
    };
  }

  if (source === "neighbourhood") {
    // Official 158-neighbourhood catalogue first (forgiving name match), then
    // the legacy downtown catalogue, then the six former boroughs (so both
    // "Woburn North" and "Scarborough" shade correctly).
    const hood = cityNeighbourhoodRing(id) ?? neighbourhoodRing(id) ?? districtRing(id);
    if (!hood) {
      const suggestions = suggestCityNeighbourhoods(id);
      const districts = TORONTO_DISTRICTS.map((d) => d.name).join(", ");
      return {
        status: "rejected",
        error:
          `No unique match for neighbourhood '${id}'.` +
          (suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}?` : "") +
          ` Districts also work: ${districts}.`,
      };
    }
    return {
      status: "rendered",
      clientName: "highlight_area",
      clientArgs: {
        polygon: hood.ring,
        label: label ?? hood.name,
        color: SEVERITY_COLOR[severity] ?? "sky",
        severity,
        source: "neighbourhood",
      },
    };
  }

  return { status: "rejected", error: `show_area source must be 'artifact' or 'neighbourhood'.` };
}

async function resolveDrawCorridor(args: Record<string, unknown>): Promise<WriteResolution> {
  const from = asPoint(args.from);
  const to = asPoint(args.to);
  if (!from || !to) return { status: "rejected", error: "draw_corridor requires `from` and `to` as [lng, lat]." };

  for (const [label, p] of [["from", from], ["to", to]] as const) {
    if (!inBBox(p[0], p[1], TORONTO_BBOX)) {
      return { status: "rejected", error: `Corridor '${label}' endpoint is outside the Toronto area.` };
    }
    const inhabited = await isInhabited(p);
    if (inhabited === false) {
      return {
        status: "rejected",
        error: `Corridor '${label}' endpoint [${p[0].toFixed(4)}, ${p[1].toFixed(4)}] is over water or uninhabited land — fetch a real coordinate with describe_location first.`,
      };
    }
  }

  // Road-snap so the drawn line follows real streets instead of cutting
  // diagonally across the city. Straight line is the graceful fallback.
  let path: [number, number][] | undefined;
  const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  if (token) {
    try {
      const snapped = await snapToRoads([{ coords: from }, { coords: to }], token, undefined, "driving");
      if (snapped.length >= 2) path = snapped;
    } catch (e) {
      console.warn("[map-data/tools] road snap failed, falling back to straight line:", e);
    }
  }

  return {
    status: "rendered",
    clientName: "draw_corridor",
    clientArgs: {
      from,
      to,
      label: typeof args.label === "string" ? args.label : "Proposed corridor",
      mode: typeof args.mode === "string" ? args.mode : "subway",
      ...(path ? { path } : {}),
    },
  };
}

async function resolveDropPin(args: Record<string, unknown>, ctx: ToolContext): Promise<WriteResolution> {
  const lng = Number(args.lng);
  const lat = Number(args.lat);
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || !inBBox(lng, lat, TORONTO_BBOX)) {
    return { status: "rejected", error: "drop_pin coordinates are missing or outside the Toronto area." };
  }
  const inhabited = await isInhabited([lng, lat]);
  if (inhabited === false) {
    return {
      status: "rejected",
      error: `Pin at [${lng.toFixed(4)}, ${lat.toFixed(4)}] is over water or uninhabited land — verify the point with describe_location first.`,
    };
  }

  // Grounded context rides along in the args (not shown in the note itself);
  // the UI can surface it and it documents what the pin actually sits near.
  const nearest = ctx.network.grid.nearest([lng, lat], 10);
  return {
    status: "rendered",
    clientName: "drop_pin",
    clientArgs: {
      lng,
      lat,
      note: typeof args.note === "string" ? args.note : "Point of interest",
      icon: typeof args.icon === "string" ? args.icon : "info",
      ...(nearest
        ? { nearestStop: { name: nearest.item.name, route: nearest.item.route, km: +nearest.km.toFixed(2) } }
        : {}),
    },
  };
}

function resolveFlyTo(args: Record<string, unknown>): WriteResolution {
  const bbox = asBBox(args.bbox);
  const [west, south, east, north] = TORONTO_BBOX;
  const ok = bbox?.every((n, i) => (i % 2 === 0 ? n >= west && n <= east : n >= south && n <= north));
  if (!ok) return { status: "rejected", error: "fly_to bbox is missing or outside the Toronto area." };
  return {
    status: "rendered",
    clientName: "fly_to",
    clientArgs: { bbox, ...(typeof args.reason === "string" ? { reason: args.reason } : {}) },
  };
}

/** Resolve any WRITE tool call into a client event or a model-facing rejection. */
export async function resolveWriteTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<WriteResolution> {
  switch (name) {
    case "show_area": return resolveShowArea(args, ctx);
    case "draw_corridor": return resolveDrawCorridor(args);
    case "drop_pin": return resolveDropPin(args, ctx);
    case "fly_to": return resolveFlyTo(args);
    default: return { status: "rejected", error: `unknown write tool: ${name}` };
  }
}
