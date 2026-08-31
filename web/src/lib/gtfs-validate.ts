/**
 * Client-side GTFS feed validator.
 *
 * Accepts a GTFSFiles map (filename → CSV string) and returns a structured
 * ValidationResult with errors and warnings.
 *
 *   Errors   = structural problems that make the feed unusable by consumers
 *   Warnings = data quality issues that won't break consumers but may cause
 *              unexpected behaviour (missing names, suspicious coordinates, etc.)
 */

import type { GTFSFiles } from "./gtfs";

// ─── types ────────────────────────────────────────────────────────────────────

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  severity: ValidationSeverity;
  code: string;
  message: string;
}

export interface ValidationResult {
  /** True when there are no errors (warnings are non-blocking). */
  valid: boolean;
  issues: ValidationIssue[];
  stats: {
    routes: number;
    trips: number;
    stops: number;
    stopTimes: number;
    shapes: number;
  };
}

// ─── CSV helpers ──────────────────────────────────────────────────────────────

type CsvRecord = Record<string, string>;

function splitLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCsv(text: string): CsvRecord[] {
  const lines = text.replace(/\r/g, "").split("\n").filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const values = splitLine(line);
    const rec: CsvRecord = {};
    for (let i = 0; i < headers.length; i++) rec[headers[i]!] = values[i] ?? "";
    return rec;
  });
}

function getHeaders(text: string): Set<string> {
  const first = text.replace(/\r/g, "").split("\n")[0] ?? "";
  return new Set(splitLine(first));
}

// ─── validation helpers ───────────────────────────────────────────────────────

const VALID_ROUTE_TYPES = new Set(["0","1","2","3","4","5","6","7","11","12","900"]);
const TIME_RE = /^\d{1,2}:\d{2}:\d{2}$/;

/** Report at most this many individual instances per category to avoid flooding the UI. */
const MAX_INSTANCES = 5;

function formatList(items: string[], total: number): string {
  const shown = items.slice(0, MAX_INSTANCES).join(", ");
  const extra = total - Math.min(total, MAX_INSTANCES);
  return extra > 0 ? `${shown} … and ${extra} more` : shown;
}

// ─── main export ──────────────────────────────────────────────────────────────

export function validateGTFS(files: GTFSFiles): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string) => issues.push({ severity: "error", code, message });
  const warn = (code: string, message: string) => issues.push({ severity: "warning", code, message });

  // ── 1. Required files ────────────────────────────────────────────────────────
  const required = ["routes.txt", "trips.txt", "stop_times.txt", "stops.txt"] as const;
  for (const f of required) {
    if (!files[f]) err("E001", `Missing required file: ${f}`);
  }
  if (!files["calendar.txt"] && !files["calendar_dates.txt"]) {
    err("E002", "Missing required file: calendar.txt (or calendar_dates.txt)");
  }
  if (!files["agency.txt"]) {
    warn("W001", "Missing agency.txt — consumers may reject this feed without agency information");
  }

  // Short-circuit: can't do further checks without core files
  if (!files["routes.txt"] || !files["trips.txt"] || !files["stop_times.txt"] || !files["stops.txt"]) {
    return {
      valid: false,
      issues,
      stats: { routes: 0, trips: 0, stops: 0, stopTimes: 0, shapes: 0 },
    };
  }

  // ── 2. Required columns ──────────────────────────────────────────────────────
  const routeHeaders  = getHeaders(files["routes.txt"]!);
  const tripHeaders   = getHeaders(files["trips.txt"]!);
  const stHeaders     = getHeaders(files["stop_times.txt"]!);
  const stopHeaders   = getHeaders(files["stops.txt"]!);

  for (const col of ["route_id", "route_type"]) {
    if (!routeHeaders.has(col)) err("E010", `routes.txt is missing required column: ${col}`);
  }
  for (const col of ["route_id", "service_id", "trip_id"]) {
    if (!tripHeaders.has(col)) err("E011", `trips.txt is missing required column: ${col}`);
  }
  for (const col of ["trip_id", "stop_id", "stop_sequence"]) {
    if (!stHeaders.has(col)) err("E012", `stop_times.txt is missing required column: ${col}`);
  }
  for (const col of ["stop_id", "stop_lat", "stop_lon"]) {
    if (!stopHeaders.has(col)) err("E013", `stops.txt is missing required column: ${col}`);
  }
  if (!stopHeaders.has("stop_name")) {
    warn("W010", "stops.txt is missing stop_name — stops will fall back to stop_id");
  }

  // If column errors exist, skip row-level checks (they'd produce noise)
  if (issues.some((i) => i.severity === "error" && i.code.startsWith("E01"))) {
    const routeRows = parseCsv(files["routes.txt"]!);
    const tripRows  = parseCsv(files["trips.txt"]!);
    const stopRows  = parseCsv(files["stops.txt"]!);
    const stRows    = parseCsv(files["stop_times.txt"]!);
    return {
      valid: false,
      issues,
      stats: {
        routes: routeRows.length, trips: tripRows.length,
        stops: stopRows.length, stopTimes: stRows.length,
        shapes: files["shapes.txt"] ? parseCsv(files["shapes.txt"]).length : 0,
      },
    };
  }

  // ── 3. Parse rows ────────────────────────────────────────────────────────────
  const routeRows = parseCsv(files["routes.txt"]!);
  const tripRows  = parseCsv(files["trips.txt"]!);
  const stRows    = parseCsv(files["stop_times.txt"]!);
  const stopRows  = parseCsv(files["stops.txt"]!);

  const stats = {
    routes:   routeRows.length,
    trips:    tripRows.length,
    stops:    stopRows.length,
    stopTimes: stRows.length,
    shapes:   files["shapes.txt"] ? parseCsv(files["shapes.txt"]).length : 0,
  };

  if (routeRows.length === 0) err("E020", "routes.txt has no data rows");
  if (stopRows.length === 0)  err("E021", "stops.txt has no data rows");
  if (stRows.length === 0)    err("E022", "stop_times.txt has no data rows");

  // ── 4. Build lookup sets ─────────────────────────────────────────────────────
  const routeIds   = new Set(routeRows.map((r) => r.route_id).filter(Boolean));
  const tripIds    = new Set(tripRows.map((t) => t.trip_id).filter(Boolean));
  const stopIds    = new Set(stopRows.map((s) => s.stop_id).filter(Boolean));

  // Service IDs from calendar / calendar_dates
  const serviceIds = new Set<string>();
  if (files["calendar.txt"]) {
    for (const r of parseCsv(files["calendar.txt"])) {
      if (r.service_id) serviceIds.add(r.service_id);
    }
  }
  if (files["calendar_dates.txt"]) {
    for (const r of parseCsv(files["calendar_dates.txt"])) {
      if (r.service_id) serviceIds.add(r.service_id);
    }
  }

  // ── 5. Route-level checks ────────────────────────────────────────────────────
  const invalidRouteTypes: string[] = [];
  for (const r of routeRows) {
    if (r.route_type && !VALID_ROUTE_TYPES.has(r.route_type.trim())) {
      invalidRouteTypes.push(`${r.route_id}(type=${r.route_type})`);
    }
  }
  if (invalidRouteTypes.length > 0) {
    warn("W020", `${invalidRouteTypes.length} route(s) have unrecognised route_type: ${formatList(invalidRouteTypes, invalidRouteTypes.length)}`);
  }

  // ── 6. Trip-level checks ─────────────────────────────────────────────────────
  const tripsUnknownRoute: string[] = [];
  const tripsUnknownService: string[] = [];
  for (const t of tripRows) {
    if (t.route_id && !routeIds.has(t.route_id)) tripsUnknownRoute.push(t.trip_id || t.route_id);
    if (serviceIds.size > 0 && t.service_id && !serviceIds.has(t.service_id)) {
      tripsUnknownService.push(t.trip_id || t.service_id);
    }
  }
  if (tripsUnknownRoute.length > 0) {
    err("E030", `${tripsUnknownRoute.length} trip(s) reference unknown route_id: ${formatList(tripsUnknownRoute, tripsUnknownRoute.length)}`);
  }
  if (tripsUnknownService.length > 0) {
    warn("W030", `${tripsUnknownService.length} trip(s) reference service_id not found in calendar: ${formatList(tripsUnknownService, tripsUnknownService.length)}`);
  }

  // Routes with no trips
  const routesWithTrips = new Set(tripRows.map((t) => t.route_id));
  const routesNoTrips = routeRows.filter((r) => r.route_id && !routesWithTrips.has(r.route_id));
  if (routesNoTrips.length > 0) {
    warn("W031", `${routesNoTrips.length} route(s) have no trips: ${formatList(routesNoTrips.map((r) => r.route_id ?? ""), routesNoTrips.length)}`);
  }

  // ── 7. Stop-level checks ─────────────────────────────────────────────────────
  let badLat = 0, badLon = 0, zeroCoordsCount = 0;
  for (const s of stopRows) {
    const lat = parseFloat(s.stop_lat ?? "");
    const lon = parseFloat(s.stop_lon ?? "");
    if (isNaN(lat) || lat < -90 || lat > 90)   badLat++;
    if (isNaN(lon) || lon < -180 || lon > 180) badLon++;
    if (!isNaN(lat) && !isNaN(lon) && lat === 0 && lon === 0) zeroCoordsCount++;
  }
  if (badLat > 0)        err("E040", `${badLat} stop(s) have invalid stop_lat (must be −90 to 90)`);
  if (badLon > 0)        err("E041", `${badLon} stop(s) have invalid stop_lon (must be −180 to 180)`);
  if (zeroCoordsCount > 0) warn("W040", `${zeroCoordsCount} stop(s) have coordinates at (0, 0) — likely missing data`);

  // ── 8. Stop-time referential integrity & time format ─────────────────────────
  const stUnknownTrip = new Set<string>();
  const stUnknownStop = new Set<string>();
  let badTimeCount = 0;

  for (const st of stRows) {
    if (st.trip_id && !tripIds.has(st.trip_id)) stUnknownTrip.add(st.trip_id);
    if (st.stop_id && !stopIds.has(st.stop_id)) stUnknownStop.add(st.stop_id);
    if (st.arrival_time && !TIME_RE.test(st.arrival_time))     badTimeCount++;
    if (st.departure_time && !TIME_RE.test(st.departure_time)) badTimeCount++;
  }
  if (stUnknownTrip.size > 0) {
    err("E050", `stop_times.txt references ${stUnknownTrip.size} unknown trip_id(s): ${formatList([...stUnknownTrip], stUnknownTrip.size)}`);
  }
  if (stUnknownStop.size > 0) {
    err("E051", `stop_times.txt references ${stUnknownStop.size} unknown stop_id(s): ${formatList([...stUnknownStop], stUnknownStop.size)}`);
  }
  if (badTimeCount > 0) {
    warn("W050", `${badTimeCount} stop_times row(s) have arrival_time/departure_time not in HH:MM:SS format`);
  }

  return {
    valid: !issues.some((i) => i.severity === "error"),
    issues,
    stats,
  };
}
