#!/usr/bin/env node
/**
 * Validate generated-routes.json.
 *
 * WHY THIS EXISTS: the route data used to be a TypeScript literal, so the
 * compiler checked its shape. It now lives in JSON and is read through a cast
 * (`as unknown as Route[]` in transit-data.ts), which means TypeScript checks
 * NOTHING about it. With 208 hand-maintained bus routes and ~7,800 coordinates,
 * a typo'd latitude or a dropped `stops` array would otherwise surface as a
 * broken map in the browser rather than a failed build.
 *
 * Run: node scripts/validate-routes.mjs   (wired into `npm run check`)
 * Exits non-zero and prints every problem found.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// 📖 Learn: __dirname doesn't exist in ES modules — derive it from import.meta.url.
const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "../src/app/map/generated-routes.json");

// Mirrors TORONTO_BBOX in src/server/map-data/geo.ts — [west, south, east, north].
const BBOX = [-79.75, 43.55, -79.05, 43.95];
const TYPES = new Set(["bus", "streetcar", "subway"]);
const ROUTE_KEYS = new Set([
  "id", "name", "shortName", "color", "textColor",
  "type", "description", "frequency", "stops", "stats",
]);
const REQUIRED = ["id", "name", "shortName", "color", "textColor", "type", "stops"];
const HEX = /^#[0-9A-Fa-f]{6}$/;
const MIN_STOPS = 2;

const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

let routes;
try {
  routes = JSON.parse(readFileSync(FILE, "utf8"));
} catch (e) {
  console.error(`✗ generated-routes.json is not valid JSON — ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(routes) || routes.length === 0) {
  console.error("✗ generated-routes.json must be a non-empty array");
  process.exit(1);
}

const seen = new Map();
let stopCount = 0;

routes.forEach((r, i) => {
  const at = `route[${i}]${r?.id ? ` (${r.id})` : ""}`;
  if (!r || typeof r !== "object" || Array.isArray(r)) return fail(at, "not an object");

  for (const k of REQUIRED) {
    if (!(k in r)) fail(at, `missing required field "${k}"`);
  }
  // Catches typos like "stps" that would silently read as undefined.
  for (const k of Object.keys(r)) {
    if (!ROUTE_KEYS.has(k)) fail(at, `unexpected field "${k}"`);
  }

  if (typeof r.id === "string") {
    if (seen.has(r.id)) fail(at, `duplicate id, also at route[${seen.get(r.id)}]`);
    else seen.set(r.id, i);
  } else if ("id" in r) fail(at, `id must be a string, got ${typeof r.id}`);

  for (const k of ["name", "shortName", "description", "frequency"]) {
    if (k in r && typeof r[k] !== "string") fail(at, `${k} must be a string`);
  }
  for (const k of ["color", "textColor"]) {
    if (k in r && !HEX.test(r[k])) fail(at, `${k} "${r[k]}" is not a #RRGGBB hex colour`);
  }
  if ("type" in r && !TYPES.has(r.type)) {
    fail(at, `type "${r.type}" not one of ${[...TYPES].join(", ")}`);
  }
  if ("stats" in r && (typeof r.stats !== "object" || r.stats === null)) {
    fail(at, "stats must be an object when present");
  }

  if (!Array.isArray(r.stops)) return fail(at, "stops must be an array");
  if (r.stops.length < MIN_STOPS) fail(at, `only ${r.stops.length} stop(s); a route needs >= ${MIN_STOPS}`);

  r.stops.forEach((s, j) => {
    stopCount++;
    const sat = `${at} stop[${j}]`;
    if (!s || typeof s !== "object") return fail(sat, "not an object");
    if (typeof s.name !== "string" || s.name.trim() === "") fail(sat, "name must be a non-empty string");
    if (!Array.isArray(s.coords) || s.coords.length !== 2) {
      return fail(sat, "coords must be [lng, lat]");
    }
    const [lng, lat] = s.coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      return fail(sat, `coords must be finite numbers, got [${lng}, ${lat}]`);
    }
    // Guards the classic mistakes: swapped lng/lat, or a dropped minus sign.
    if (lng < BBOX[0] || lng > BBOX[2] || lat < BBOX[1] || lat > BBOX[3]) {
      fail(sat, `"${s.name}" at [${lng}, ${lat}] is outside Toronto ${JSON.stringify(BBOX)}`);
    }
  });
});

if (errors.length) {
  console.error(`✗ generated-routes.json: ${errors.length} problem(s)\n`);
  for (const e of errors.slice(0, 40)) console.error(`  ${e}`);
  if (errors.length > 40) console.error(`  … and ${errors.length - 40} more`);
  process.exit(1);
}

console.log(`✓ generated-routes.json: ${routes.length} routes, ${stopCount} stops, all valid`);
