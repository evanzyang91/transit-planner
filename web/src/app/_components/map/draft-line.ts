/**
 * A line the Ask AI assistant *drafted* (propose_line) — previewed on the map
 * as a teal dashed line until the user clicks "Add" on the confirm card in the
 * chat. Nothing in here touches React or Mapbox, so it is unit-tested directly.
 *
 * Human-in-the-loop rule: the assistant can only PROPOSE. `draftToRoute` is
 * called from TransitMap's commitDraftLine, which only runs on the user's click.
 */

import { LINE_TYPES, type DraftLine } from "~/lib/map-assistant-protocol";
import type { Route } from "~/app/map/transit-data";

/** teal-500. AI surfaces are teal; the committed line keeps the colour the assistant picked. */
export const DRAFT_PREVIEW_COLOR = "#14b8a6";

/** A draft longer than this is almost certainly a malformed tool call, not a transit line. */
const MAX_DRAFT_STOPS = 100;

/**
 * Badge text for a line, using the same rule as the New Line modal:
 * first letters of the first two words ("Eglinton Crosstown" → "EC"),
 * or the first two letters of a single word ("Ontario" → "ON").
 */
export function autoShortName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const words = trimmed.split(/\s+/);
  const first = words[0] ?? "";
  const second = words[1] ?? "";
  if (words.length >= 2 && first && second) {
    return (first.charAt(0) + second.charAt(0)).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * "#abc" or "#AABBCC" → "#aabbcc"; anything else → `fallback`.
 * Why: the map's route styling (darkenColor in TransitMap) parses six hex
 * digits, so a 3-digit or named colour would turn into NaN.
 */
export function normalizeHexColor(color: string, fallback: string = DRAFT_PREVIEW_COLOR): string {
  const value = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(value)) return value;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(value);
  if (short) {
    const [, r = "0", g = "0", b = "0"] = short;
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return fallback;
}

function isValidLngLat(coords: unknown): coords is [number, number] {
  if (!Array.isArray(coords) || coords.length !== 2) return false;
  const [lng, lat] = coords as unknown[];
  return (
    typeof lng === "number" &&
    typeof lat === "number" &&
    Number.isFinite(lng) &&
    Number.isFinite(lat) &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

/**
 * Why a draft can't be added, as a short sentence for the chat card — or null
 * when it is fine. (parseAppAction already checked the basic shape; this adds
 * the checks that matter for turning it into a real line.)
 */
export function validateDraftLine(draft: DraftLine): string | null {
  if (typeof draft.draftId !== "string" || draft.draftId.length === 0) return "The draft has no id.";
  if (typeof draft.name !== "string" || draft.name.trim().length === 0) return "The draft line has no name.";
  if (!LINE_TYPES.includes(draft.type)) return `"${String(draft.type)}" is not a line type this map supports.`;
  // The card can be clicked long after the draft arrived (it is re-read from
  // saved chat history), so check the fields draftToRoute calls .trim() on.
  if (typeof draft.color !== "string") return "The draft line has no colour.";
  if (!Array.isArray(draft.stops) || draft.stops.length < 2) return "A line needs at least two stops.";
  if (draft.stops.length > MAX_DRAFT_STOPS) return `A line can have at most ${MAX_DRAFT_STOPS} stops.`;
  for (const stop of draft.stops) {
    if (typeof stop.name !== "string") return "One of the stops has no name.";
    if (!isValidLngLat(stop.coords)) return "One of the stops has invalid coordinates.";
  }
  return null;
}

/**
 * The first `custom-N` id (N ≥ counter) that no existing route uses.
 * Why not just `custom-${counter++}` like the New Line modal: after a saved
 * plan or a share link is loaded, the counter still starts at 1 while the
 * plan may already contain custom-1, and two routes with one id share map
 * layers (the second one never draws).
 */
export function nextCustomLineId(
  existingIds: Iterable<string>,
  counter: number,
): { id: string; nextCounter: number } {
  const taken = new Set(existingIds);
  let n = Math.max(1, Math.floor(counter));
  while (taken.has(`custom-${n}`)) n += 1;
  return { id: `custom-${n}`, nextCounter: n + 1 };
}

/**
 * The draft as a real Route, built exactly like a line made with the New Line
 * modal (same defaults: white badge text, "Custom line", no frequency yet),
 * except the stops are already placed. Every stop gets a fresh id from
 * `makeStopId` (pass `newStopId` from stop-identity), because stop ids — not
 * names — are how delete/drag/rename find a stop.
 */
export function draftToRoute(
  draft: DraftLine,
  options: { id: string; makeStopId: () => string },
): Route {
  const name = draft.name.trim();
  return {
    id: options.id,
    name,
    shortName: autoShortName(name),
    color: normalizeHexColor(draft.color),
    textColor: "#ffffff",
    type: draft.type,
    description: "Custom line",
    frequency: "—",
    stops: draft.stops.map((stop, index) => ({
      id: options.makeStopId(),
      name: stop.name.trim() || `Station ${index + 1}`,
      // Copy the pair so the new route never shares an array with the chat transcript.
      coords: [stop.coords[0], stop.coords[1]] as [number, number],
    })),
  };
}

/** GeoJSON for the preview: one dashed LineString through the stops + one point per stop. */
export function draftPreviewGeoJSON(draft: DraftLine): {
  line: GeoJSON.Feature<GeoJSON.LineString>;
  stops: GeoJSON.FeatureCollection<GeoJSON.Point>;
} {
  return {
    line: {
      type: "Feature",
      properties: { draftId: draft.draftId },
      geometry: { type: "LineString", coordinates: draft.stops.map((stop) => [stop.coords[0], stop.coords[1]]) },
    },
    stops: {
      type: "FeatureCollection",
      features: draft.stops.map((stop, index) => ({
        type: "Feature",
        properties: { name: stop.name, index },
        geometry: { type: "Point", coordinates: [stop.coords[0], stop.coords[1]] },
      })),
    },
  };
}

/** [west, south, east, north] around a list of [lng, lat] points, or null for an empty list. */
export function coordsBounds(
  coords: ReadonlyArray<readonly [number, number]>,
): [number, number, number, number] | null {
  if (coords.length === 0) return null;
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < west) west = lng;
    if (lng > east) east = lng;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }
  return [west, south, east, north];
}
