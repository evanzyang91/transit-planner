/**
 * THE contract between the Ask AI map assistant's browser side and server side
 * (POST /api/ai/chat with `mapTools: true`). Safe to import on both sides — no
 * server-only code here, only types, constants and tiny validators.
 *
 * Why one file: the client chat, the server agent loop, the TransitMap action
 * handler and the benchmark script all have to agree on the same event names
 * and shapes. When they each kept their own copy, they drifted (the reset_network
 * tool was sent by the server but silently dropped by the client).
 *
 * Design choices (2026-11 rework):
 *  • STATELESS server. The browser keeps the conversation (localStorage) and
 *    sends it back as `history` on every request, so a restart / hot reload /
 *    serverless hop can no longer lose it ("Unknown thread: <uuid>").
 *  • The transcript format is PROVIDER-NEUTRAL: plain text, tool calls and tool
 *    results — the common denominator of Anthropic, Gemini and MCP-style agent
 *    frameworks (e.g. the sibling ../transit-agents project), so a different
 *    backend can drive the same map later without a format migration.
 *
 * 📖 Learn: "discriminated union" — every event has a `type` string literal, so
 * `switch (event.type)` narrows the TypeScript type in each branch.
 */

// ── Transcript (what the browser stores and sends back) ──────────────────────

export type TranscriptBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface TranscriptMessage {
  role: "user" | "assistant";
  /** A plain string is shorthand for one text block. */
  content: string | TranscriptBlock[];
}

/**
 * Size limits for the client-held history. The server enforces them (the body
 * comes from the browser, so it is untrusted); the client applies the same caps
 * before sending, so requests stay small.
 */
export const HISTORY_LIMITS = {
  /** Keep the last N user turns (a turn = user message + everything until the next user text). */
  maxUserTurns: 12,
  /** Serialized JSON size cap for the whole history; oldest turns are dropped first. */
  maxBytes: 120_000,
  /** Each tool_result's content is truncated to this many characters. */
  maxToolResultChars: 6_000,
  /** Each text block is truncated to this many characters. */
  maxTextChars: 8_000,
} as const;

// ── Request body ─────────────────────────────────────────────────────────────

export interface MapChatRequest {
  message: string;
  /** Earlier turns, oldest first. Omit or [] for a new conversation. */
  history?: TranscriptMessage[];
  /** Live routes on the user's map (sanitised server-side, see map-data/network.ts). */
  networkRoutes?: unknown;
  /** What the user can currently see — lets the assistant answer "what is this heatmap?". */
  ui?: MapUiSnapshot;
  provider?: "anthropic" | "gemini";
  /** Must be true for this protocol (kept for backward compatibility with older clients). */
  mapTools: true;
  /** Only set by the benchmark script — tags the Langfuse trace so it can be found again. */
  benchmarkRunId?: string;
}

// ── Server-sent events (one JSON object per `data:` line) ────────────────────

export type MapChatEvent =
  /** Sent immediately so the client knows the request was accepted. */
  | { type: "start"; model: string }
  /**
   * One step of visible progress for the "what I'm doing" list.
   * The same `id` is sent again with state "done" or "error" when it finishes.
   */
  | { type: "status"; id: string; tool: string; label: string; state: "running" | "done" | "error" }
  /** A chunk of the visible answer, streamed token by token. */
  | { type: "text"; delta: string }
  /**
   * The text streamed since the last reset turned out to be mid-step narration
   * ("Let me check Scarborough…") rather than the answer: the client removes it
   * from the answer bubble and may show `note` as a dim progress line instead.
   */
  | { type: "text_reset"; note?: string }
  /**
   * Something the browser must act on: an annotation to draw (ANNOTATION_TOOL_NAMES)
   * or an app action (APP_ACTION_NAMES). Args are SERVER-resolved and validated.
   */
  | { type: "tool_call"; name: ClientToolName; args: Record<string, unknown> }
  /**
   * The transcript of this turn (starting with the user's message) to append to
   * the stored history. Sent once, right before `done` — also after an error,
   * so a failed turn is remembered rather than silently forgotten.
   */
  | { type: "turn"; messages: TranscriptMessage[] }
  | { type: "error"; error: string; retryable?: boolean }
  | { type: "done" };

// ── What the user currently sees ─────────────────────────────────────────────

/**
 * Every overlay the snapshot can report. Ids are stable — the server explains
 * each one from OVERLAY_CATALOG in ~/lib/project-knowledge.ts, so the client
 * sends ids and numbers only (never prose that would end up in the prompt).
 */
export const MAP_LAYER_IDS = [
  "population", // Population Density heatmap (census, log-scaled)
  "canadaPop", // Canada-wide population density heatmap
  "serviceHeatmap", // Stop density weighted by mode
  "transitDesert", // Underserved population heatmap
  "traffic", // Stored average road traffic, coloured lines
  "coverage", // "500 m" circles per stop
  "catchment", // Walk-shed rings per station
  "disruption", // Impact buffers around a route
  "isochrone", // Travel-time polygons from an origin
  "liveVehicles", // TTC GTFS-RT vehicle dots
  "stationLabels",
  "aiFindings", // The assistant's own shading / pins / corridors
  "customOverlay", // A KML/KMZ/SHP the user loaded
  "simStress", // Simulation segment stress lines
  "simAgents", // Simulation commuter dots
] as const;
export type MapLayerId = (typeof MAP_LAYER_IDS)[number];

/** The overlays the assistant may switch on/off with set_map_layers. */
export const TOGGLEABLE_LAYER_IDS = [
  "population",
  "canadaPop",
  "serviceHeatmap",
  "transitDesert",
  "traffic",
  "coverage",
  "catchment",
  "liveVehicles",
  "stationLabels",
  "aiFindings",
] as const satisfies readonly MapLayerId[];
export type ToggleableLayerId = (typeof TOGGLEABLE_LAYER_IDS)[number];

export const PANEL_IDS = ["simulation", "plans", "analysis", "none"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export interface MapUiSnapshot {
  v: 1;
  /** Map camera. bounds = [west, south, east, north]. */
  viewport?: {
    center: [number, number];
    zoom: number;
    bounds: [number, number, number, number];
    neighbourhoodAtCenter?: string | null;
  };
  /** Overlays that are ON (or loading). Layers not listed are off. */
  layers: Array<{ id: MapLayerId; on: boolean; loading?: boolean; detail?: string }>;
  selection?: {
    routeId?: string | null;
    routeName?: string | null;
    stopName?: string | null;
    neighbourhood?: string | null;
    selectedNeighbourhoods?: string[];
  };
  panels?: {
    simulation?: boolean;
    plans?: boolean;
    analysis?: boolean;
    routePanel?: boolean;
    council?: "closed" | "open" | "running";
  };
  network?: {
    hiddenRouteIds?: string[];
    customLines?: Array<{ id: string; name: string; type: string; stops: number }>;
    /** Bus routes currently loaded into the plan (the other ~200 TTC buses are not counted). */
    busRoutesLoaded?: number;
    goTransit?: boolean;
    planName?: string | null;
    unsavedChanges?: boolean;
  };
  /** Latest Simulate result, if any (compact — no per-agent data). */
  simulation?: {
    scenario: string;
    agents: number;
    baselinePctAccessible?: number;
    scenarioPctAccessible?: number;
    timeSavedMin?: number;
    newlyAccessible?: number;
    equityImprovement?: number;
    topStress?: Array<{ line?: string; from: string; to: string; stressPct: number; deltaPct?: number }>;
  } | null;
  prefs?: { dark?: boolean; imperial?: boolean };
  signedIn?: boolean;
}

// ── Things the browser acts on (tool_call event names) ───────────────────────

/** Drawn on the map as AI annotations (AIAnnotationsContext). */
export const ANNOTATION_TOOL_NAMES = ["highlight_area", "draw_corridor", "drop_pin", "fly_to"] as const;
export type AnnotationToolName = (typeof ANNOTATION_TOOL_NAMES)[number];

/** App actions handled by TransitMap. Mutating ones only OPEN a confirm UI. */
export const APP_ACTION_NAMES = [
  "reset_network", // opens the Reset dialog (mutating → confirm)
  "set_map_layers", // view only
  "show_isochrone", // view only
  "focus", // view only: select a route / neighbourhood and fly to it
  "set_route_visibility", // view only (hidden lines are saved with plans, but nothing is deleted)
  "open_panel", // view only
  "show_simulation", // displays server-computed simulation results in the Simulate panel
  "propose_line", // draft preview + confirm card (mutating → confirm)
] as const;
export type AppActionName = (typeof APP_ACTION_NAMES)[number];

export type ClientToolName = AnnotationToolName | AppActionName;

export type LineType = "subway" | "lrt" | "streetcar" | "bus";
export const LINE_TYPES: readonly LineType[] = ["subway", "lrt", "streetcar", "bus"];

export interface DraftLine {
  /** Unique per proposal, so the confirm card and the map preview refer to the same draft. */
  draftId: string;
  name: string;
  type: LineType;
  /** Hex colour, e.g. "#14b8a6". */
  color: string;
  stops: Array<{ name: string; coords: [number, number] }>;
  stats: {
    lengthKm: number;
    stopCount: number;
    avgSpacingKm: number;
    populationServed?: number;
    estCostBillions?: number;
  };
  rationale?: string;
}

/** Typed args for each app action, as sent by the server (already validated there). */
export type AppAction =
  | { name: "reset_network"; args: { target: "default" | "empty" } }
  | { name: "set_map_layers"; args: { layers: Array<{ id: ToggleableLayerId; on: boolean }> } }
  | {
      name: "show_isochrone";
      args:
        | { origin: [number, number]; minutes: 15 | 30 | 45 | 60; mode: "walking" | "cycling" | "driving" }
        | { clear: true };
    }
  | {
      name: "focus";
      args:
        | { target: "route"; routeId: string; routeName: string }
        | { target: "neighbourhood"; name: string; bbox?: [number, number, number, number] };
    }
  | { name: "set_route_visibility"; args: { routeIds: string[]; visible: boolean } }
  | { name: "open_panel"; args: { panel: PanelId } }
  /** `result` is exactly what POST /api/simulation returns (SimulationPanel's SimulationResult). */
  | { name: "show_simulation"; args: { result: unknown } }
  | { name: "propose_line"; args: DraftLine };

export function isAnnotationToolName(name: unknown): name is AnnotationToolName {
  return typeof name === "string" && (ANNOTATION_TOOL_NAMES as readonly string[]).includes(name);
}

export function isAppActionName(name: unknown): name is AppActionName {
  return typeof name === "string" && (APP_ACTION_NAMES as readonly string[]).includes(name);
}

function isLngLat(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n));
}

/**
 * Client-side guard for an app action coming off the wire. The server already
 * validated it; this is defence in depth so a malformed event can never crash
 * TransitMap. Returns null for anything that doesn't match the contract.
 */
export function parseAppAction(name: string, args: Record<string, unknown>): AppAction | null {
  switch (name) {
    case "reset_network":
      return args.target === "default" || args.target === "empty"
        ? { name, args: { target: args.target } }
        : null;
    case "set_map_layers": {
      if (!Array.isArray(args.layers)) return null;
      const layers = args.layers.filter(
        (l): l is { id: ToggleableLayerId; on: boolean } =>
          typeof l === "object" &&
          l !== null &&
          (TOGGLEABLE_LAYER_IDS as readonly string[]).includes((l as { id?: unknown }).id as string) &&
          typeof (l as { on?: unknown }).on === "boolean",
      );
      return layers.length ? { name, args: { layers } } : null;
    }
    case "show_isochrone":
      if (args.clear === true) return { name, args: { clear: true } };
      if (
        isLngLat(args.origin) &&
        [15, 30, 45, 60].includes(args.minutes as number) &&
        ["walking", "cycling", "driving"].includes(args.mode as string)
      ) {
        return {
          name,
          args: {
            origin: args.origin,
            minutes: args.minutes as 15 | 30 | 45 | 60,
            mode: args.mode as "walking" | "cycling" | "driving",
          },
        };
      }
      return null;
    case "focus":
      if (args.target === "route" && typeof args.routeId === "string") {
        // A non-string routeName (e.g. an object) falls back to the id instead of "[object Object]".
        const routeName = typeof args.routeName === "string" ? args.routeName : args.routeId;
        return { name, args: { target: "route", routeId: args.routeId, routeName } };
      }
      if (args.target === "neighbourhood" && typeof args.name === "string") {
        const bbox =
          Array.isArray(args.bbox) && args.bbox.length === 4 && args.bbox.every((n) => typeof n === "number")
            ? (args.bbox as [number, number, number, number])
            : undefined;
        return { name, args: { target: "neighbourhood", name: args.name, bbox } };
      }
      return null;
    case "set_route_visibility":
      // No `as string[]` needed: `.every((id) => typeof id === "string")` already
      // narrows the array to string[]. 📖 Learn: inferred type predicates (TS 5.5+).
      return Array.isArray(args.routeIds) &&
        args.routeIds.every((id) => typeof id === "string") &&
        typeof args.visible === "boolean"
        ? { name, args: { routeIds: args.routeIds, visible: args.visible } }
        : null;
    case "open_panel":
      return (PANEL_IDS as readonly string[]).includes(args.panel as string)
        ? { name, args: { panel: args.panel as PanelId } }
        : null;
    case "show_simulation":
      return args.result && typeof args.result === "object" ? { name, args: { result: args.result } } : null;
    case "propose_line": {
      const stops = Array.isArray(args.stops) ? args.stops : [];
      const okStops = stops.every(
        (s) => typeof s === "object" && s !== null && typeof (s as { name?: unknown }).name === "string" && isLngLat((s as { coords?: unknown }).coords),
      );
      if (
        typeof args.draftId !== "string" ||
        typeof args.name !== "string" ||
        !LINE_TYPES.includes(args.type as LineType) ||
        typeof args.color !== "string" ||
        stops.length < 2 ||
        !okStops ||
        typeof args.stats !== "object" ||
        args.stats === null
      ) {
        return null;
      }
      return { name, args: args as unknown as DraftLine };
    }
    default:
      return null;
  }
}

// ── Human-readable progress labels (shared by server status events and the UI) ─

const TOOL_LABELS: Record<string, string> = {
  rank_service_areas: "Ranking service areas",
  query_population: "Measuring population",
  estimate_ridership: "Estimating ridership",
  query_network: "Looking up the network",
  describe_location: "Checking the location",
  network_coverage: "Measuring coverage",
  lookup_app_docs: "Reading the app guide",
  show_area: "Shading an area",
  draw_corridor: "Drawing a corridor",
  drop_pin: "Dropping a pin",
  fly_to: "Moving the map",
  reset_network: "Opening the reset dialog",
  set_map_layers: "Switching map layers",
  show_isochrone: "Drawing travel times",
  focus: "Focusing the map",
  set_route_visibility: "Showing / hiding lines",
  open_panel: "Opening a panel",
  run_simulation: "Running the commuter simulation",
  propose_line: "Drafting a new line",
};

export function toolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName.replace(/_/g, " ");
}
