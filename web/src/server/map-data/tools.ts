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
 *  • APP ACTIONS (view control, the commuter simulation, draft lines) are
 *    validated in ./tools-actions.ts. They only change what is shown, or open
 *    a confirm UI (Reset dialog, draft-line card) — never the user's data.
 *
 * Definitions are plain JSON Schema with no provider-specific code, so the
 * same registry can later be served to other agent runtimes (e.g. over MCP)
 * without rewriting it.
 *
 * 📖 Learn: this "artifact/reference" pattern is how you make hallucination
 * structurally impossible for a class of outputs — the model chooses among
 * server-computed options instead of generating free-form values.
 */

import { haversineKm } from "~/app/map/geo-utils";
import { POPULATION_CENTERS } from "~/app/map/population-centers";
import { snapToRoads } from "~/lib/road-snap";
import {
  LINE_TYPES,
  PANEL_IDS,
  TOGGLEABLE_LAYER_IDS,
  parseAppAction,
  type MapUiSnapshot,
} from "~/lib/map-assistant-protocol";
import { LOOKUP_TOPICS, OVERLAY_CATALOG, isLookupTopic, lookupKnowledge } from "~/lib/project-knowledge";
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
import { isInhabited } from "./inhabited";
import type { LiveNetwork } from "./network";
import {
  CHAT_SIM_AGENTS,
  DRAFT_SPACING_KM,
  DRAFT_STOP_LIMITS,
  resolveFocus,
  resolveOpenPanel,
  resolveProposeLine,
  resolveRunSimulation,
  resolveSetMapLayers,
  resolveSetRouteVisibility,
  resolveShowIsochrone,
} from "./tools-actions";

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
  /** Drop one id (e.g. when the turn that computed it was trimmed from the history). */
  forget(id: string): void {
    this.areas.delete(id.trim().toLowerCase());
  }
  get knownIds(): string[] {
    return [...this.areas.keys()];
  }
}

export interface ToolContext {
  network: LiveNetwork;
  artifacts: ArtifactStore;
  /**
   * What the user currently sees (sanitizeUiSnapshot output), or null/absent
   * when the client didn't send one. Action tools read it to give accurate
   * notes ("that layer was already on", "the Plans panel needs sign-in").
   */
  ui?: MapUiSnapshot | null;
  /**
   * Aborted when the client disconnects — long tools (run_simulation) check it
   * so an abandoned request doesn't keep working.
   */
  signal?: AbortSignal;
  // (The old `systemPrompt` field is gone: the prompt is built separately by
  // prompt.ts buildMapAssistantPrompt and handed to the provider directly.)
  /**
   * Set only by the automated benchmark script (scripts/ai-benchmark/run.mjs).
   * Recorded on the turn's Langfuse trace so the runner can look the trace back
   * up afterward and inspect READ-tool calls — those never reach the client's
   * SSE stream (only WRITE tools that actually render do), so this is the only
   * way to verify read-tool selection from outside the process.
   */
  benchmarkRunId?: string;
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

// isInhabited (the raster "do people live here?" check) moved to ./inhabited.ts
// so the app-action resolvers in ./tools-actions.ts can share it.

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

export const LOOKUP_APP_DOCS_TOOL: ToolDefinition = {
  name: "lookup_app_docs",
  description:
    "Read the app's own methodology notes on ONE topic before explaining how a number is calculated or " +
    "where data comes from (formulas, thresholds, data sources, cost models, the simulation, the council, " +
    "privacy, roadmap, tech stack). Not needed for what APP KNOWLEDGE already covers (layers, buttons, how-tos). " +
    "Topics: coverage_and_gaps (coverage share, gap ranking, population served), ridership_model, route_score, " +
    "costs (why panels disagree), simulation, council, transit_desert, population_data, live_data, privacy, " +
    "roadmap (and changelog), tech_stack.",
  inputSchema: {
    type: "object",
    properties: {
      topic: { type: "string", enum: [...LOOKUP_TOPICS], description: "The one topic to read." },
    },
    required: ["topic"],
  },
};

export const READ_TOOLS: ToolDefinition[] = [
  RANK_SERVICE_AREAS_TOOL,
  QUERY_POPULATION_TOOL,
  ESTIMATE_RIDERSHIP_TOOL,
  QUERY_NETWORK_TOOL,
  DESCRIBE_LOCATION_TOOL,
  NETWORK_COVERAGE_TOOL,
  LOOKUP_APP_DOCS_TOOL,
];

export const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.name));

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

/**
 * The first WRITE tool that touches real project data rather than drawing an
 * annotation. It never deletes anything itself: it only OPENS the app's
 * existing Reset confirmation dialog, and the user has to click Reset. That
 * human-in-the-loop step is deliberate — an LLM misreading "clear the map"
 * must not be able to destroy unsaved work.
 */
export const RESET_NETWORK_TOOL: ToolDefinition = {
  name: "reset_network",
  description:
    "Open the app's Reset confirmation dialog when the user asks to reset, wipe, clear out or " +
    "start over with their project's routes and stations. target='empty' removes EVERY route " +
    "and station (blank map); target='default' restores the original TTC network. Nothing is " +
    "deleted until the user clicks Reset in the dialog, and they can switch target there. " +
    "Do NOT use this to remove your own shading/pins/corridors.",
  inputSchema: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["empty", "default"],
        description:
          "'empty' for wipe/delete everything/blank map/from scratch; 'default' for restore/back to the original network.",
      },
    },
    required: ["target"],
  },
};

// ── APP ACTION definitions (view control, simulation, draft lines) ───────────
// Schemas stick to the JSON-Schema subset BOTH providers accept: string enums
// only (no numeric enums), no anyOf/oneOf, no additionalProperties, every
// object with at least one property. Gemini's function-declaration schema
// rejects the rest. Ranges the schema can't express are stated in the
// description and enforced by the resolver (tools-actions.ts).

/** "population = Population Density; traffic = Traffic; …" — built from the catalogue so labels can't drift. */
const TOGGLEABLE_LAYER_GLOSSARY = TOGGLEABLE_LAYER_IDS.map((id) => `${id} = ${OVERLAY_CATALOG[id].label}`).join("; ");

export const SET_MAP_LAYERS_TOOL: ToolDefinition = {
  name: "set_map_layers",
  description:
    "Switch map overlays on or off — use when the user asks to show, hide, turn on or off a layer or heatmap. " +
    `View only; nothing in the plan changes. Ids: ${TOGGLEABLE_LAYER_GLOSSARY} (aiFindings = your own drawings). ` +
    "Travel-time areas use show_isochrone instead.",
  inputSchema: {
    type: "object",
    properties: {
      layers: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        description: "Each overlay to change.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: [...TOGGLEABLE_LAYER_IDS] },
            on: { type: "boolean", description: "true = switch on, false = switch off." },
          },
          required: ["id", "on"],
        },
      },
    },
    required: ["layers"],
  },
};

export const SHOW_ISOCHRONE_TOOL: ToolDefinition = {
  name: "show_isochrone",
  description:
    "Show how far someone can get from one point within 15, 30, 45 or 60 minutes by walking, cycling or driving " +
    "(Mapbox isochrone — transit is NOT modelled). Use for 'how far can I walk from X', 'show the 30-minute area " +
    "around this station'. Get the origin's real coordinate first (describe_location, query_network nearest_stop). " +
    "clear: true removes the current one. View only.",
  inputSchema: {
    type: "object",
    properties: {
      origin: { ...POINT_SCHEMA, description: "[longitude, latitude] of the starting point, inside Toronto." },
      minutes: { type: "integer", description: "Travel-time budget: 15, 30, 45 or 60 (default 30)." },
      mode: { type: "string", enum: ["walking", "cycling", "driving"], description: "Default walking." },
      clear: { type: "boolean", description: "true = remove the current isochrone (other fields are ignored)." },
    },
  },
};

export const FOCUS_TOOL: ToolDefinition = {
  name: "focus",
  description:
    "Select a transit line (the map moves to it and its Route panel opens) or move the map to a neighbourhood. " +
    "Use for 'show me / zoom to / focus on / open Line 2', 'take me to Leaside'. Lines must be in the user's plan " +
    "(the route list in the request context has their names and ids). View only.",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "string", enum: ["route", "neighbourhood"] },
      name: {
        type: "string",
        description:
          "For a route: its name, badge or id ('Line 1', '504', 'King', 'custom-2'). For a neighbourhood: one of " +
          "Toronto's 158 neighbourhoods or a former borough ('Leaside-Bennington', 'Scarborough').",
      },
    },
    required: ["target", "name"],
  },
};

export const SET_ROUTE_VISIBILITY_TOOL: ToolDefinition = {
  name: "set_route_visibility",
  description:
    "Show or hide transit lines on the map — use for 'hide the streetcars', 'only show the subway', 'show the 95 bus'. " +
    "View only: hidden lines stay in the plan and still count in every measure (hidden lines are saved with plans). " +
    "Accepts any line in the plan, plus any TTC bus route by number — showing a bus route that isn't loaded only draws it.",
  inputSchema: {
    type: "object",
    properties: {
      routes: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 30,
        description: "Line names, badges or ids, e.g. ['Line 4', '501', 'custom-0'].",
      },
      visible: { type: "boolean", description: "true = show, false = hide." },
    },
    required: ["routes", "visible"],
  },
};

export const OPEN_PANEL_TOOL: ToolDefinition = {
  name: "open_panel",
  description:
    "Open a side panel, or close them with 'none' — use for 'open the simulation panel', 'show my saved plans', " +
    "'open the analysis tools', 'close the panels'. simulation = Simulate panel (opening it does not run anything — " +
    "use run_simulation for that); plans = Plans (saved plans, needs sign-in); analysis = Analysis panel (20 tools).",
  inputSchema: {
    type: "object",
    properties: {
      panel: { type: "string", enum: [...PANEL_IDS] },
    },
    required: ["panel"],
  },
};

export const RUN_SIMULATION_TOOL: ToolDefinition = {
  name: "run_simulation",
  description:
    "Run the commuter simulation on the server — the same engine as the Simulate panel — comparing the built-in TTC " +
    "network with the user's custom lines (lines they drew or the council added). Use when the user asks to run, test " +
    "or simulate their network or a new line, or how a proposal would perform. Takes a few seconds: call it at most " +
    "once per request. The results open in the Simulate panel and come back to you as a summary to explain.",
  inputSchema: {
    type: "object",
    properties: {
      agents: {
        type: "integer",
        description: `Simulated commuters, ${CHAT_SIM_AGENTS.min}–${CHAT_SIM_AGENTS.max} (default ${CHAT_SIM_AGENTS.default}; about 2 s per 500).`,
      },
    },
  },
};

export const PROPOSE_LINE_TOOL: ToolDefinition = {
  name: "propose_line",
  description:
    "Draft a NEW transit line for the user to review — use when they ask you to add, build, propose or sketch a line " +
    "between places. Fetch real stop coordinates first (describe_location, query_network, query_population's densest " +
    `blocks). The server checks the stops (inside Toronto, on inhabited land, ${DRAFT_SPACING_KM.min}–${DRAFT_SPACING_KM.max} km ` +
    "apart, in travel order, no duplicates), computes length, population served and cost, and shows a draft with a " +
    "confirm card. NOTHING is added until the user clicks 'Add to map'. For a quick drawing only, use draw_corridor.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Line name, e.g. 'Eglinton East LRT'." },
      type: { type: "string", enum: [...LINE_TYPES] },
      stops: {
        type: "array",
        minItems: DRAFT_STOP_LIMITS.min,
        maxItems: DRAFT_STOP_LIMITS.max,
        description: "Stops in travel order, each with a REAL coordinate you fetched with a tool.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Station name, e.g. the cross street." },
            coords: POINT_SCHEMA,
          },
          required: ["name", "coords"],
        },
      },
      color: { type: "string", description: "Optional hex colour like #14b8a6 (default depends on the type)." },
      rationale: { type: "string", description: "One sentence on why this line, shown on the confirm card." },
    },
    required: ["name", "type", "stops"],
  },
};

export const WRITE_TOOLS: ToolDefinition[] = [
  SHOW_AREA_TOOL,
  DRAW_CORRIDOR_TOOL,
  DROP_PIN_TOOL,
  FLY_TO_TOOL,
  RESET_NETWORK_TOOL,
  SET_MAP_LAYERS_TOOL,
  SHOW_ISOCHRONE_TOOL,
  FOCUS_TOOL,
  SET_ROUTE_VISIBILITY_TOOL,
  OPEN_PANEL_TOOL,
  RUN_SIMULATION_TOOL,
  PROPOSE_LINE_TOOL,
];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.name));

/**
 * The full map-assistant toolset, in a FIXED order (reads, then writes/actions).
 * Why it matters: tool definitions are the first part of the prompt prefix the
 * provider caches, so the list must be byte-identical on every request — built
 * once from module constants, never per request.
 */
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

function runLookupAppDocs(args: Record<string, unknown>) {
  if (!isLookupTopic(args.topic)) {
    return { error: `Unknown topic '${String(args.topic)}'. Valid topics: ${LOOKUP_TOPICS.join(", ")}.` };
  }
  return { topic: args.topic, text: lookupKnowledge(args.topic) };
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
    case "lookup_app_docs": return runLookupAppDocs(args);
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
 *
 * `modelNote` (optional) rides along in the model's tool_result when
 * "rendered_on_map" alone would mislead it — e.g. reset_network only opens a
 * dialog, so the model must not tell the user their map is already wiped.
 *
 * `modelData` (optional) is data the MODEL needs from an action, kept separate
 * from what the browser gets: run_simulation sends the full panel result to
 * the browser (clientArgs, ~1 MB) but only a compact summary to the model.
 */
export type WriteResolution =
  | {
      status: "rendered";
      clientName: string;
      clientArgs: Record<string, unknown>;
      modelNote?: string;
      modelData?: unknown;
    }
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

function resolveResetNetwork(args: Record<string, unknown>, ctx: ToolContext): WriteResolution {
  // Validated with the shared protocol's parser — the same check the browser
  // runs on this event, so server and client can't disagree on valid targets.
  if (parseAppAction("reset_network", args) === null) {
    return { status: "rejected", error: "reset_network requires target: 'empty' or 'default'." };
  }
  // Grounded against the live network the client sent: wiping an already
  // empty map is a no-op, so tell the model instead of popping a pointless dialog.
  if (args.target === "empty" && ctx.network.stats.routeCount === 0) {
    return { status: "rejected", error: "The map is already empty — there are no routes or stations to wipe. Tell the user so." };
  }
  return {
    status: "rendered",
    clientName: "reset_network",
    clientArgs: { target: args.target },
    modelNote:
      "A confirmation dialog is now open. NOTHING has been deleted yet — the user must click Reset " +
      "(they can also export first, cancel, or switch between empty map and default network).",
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
    case "reset_network": return resolveResetNetwork(args, ctx);
    // App actions — resolvers live in ./tools-actions.ts.
    case "set_map_layers": return resolveSetMapLayers(args, ctx);
    case "show_isochrone": return resolveShowIsochrone(args);
    case "focus": return resolveFocus(args, ctx);
    case "set_route_visibility": return resolveSetRouteVisibility(args, ctx);
    case "open_panel": return resolveOpenPanel(args, ctx);
    case "run_simulation": return resolveRunSimulation(args, ctx);
    case "propose_line": return resolveProposeLine(args, ctx);
    default: return { status: "rejected", error: `unknown write tool: ${name}` };
  }
}
