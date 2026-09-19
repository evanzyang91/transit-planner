#!/usr/bin/env node
/**
 * eval-routes — run the LIVE council against the golden selections and record
 * exactly what it produces, scored by `src/server/route-metrics.ts`.
 *
 * WHY THIS EXISTS: the investigation into squiggly council routes could not run
 * the council (no credentials in its worktree), so every claim about what the
 * model *actually emits* was inference. This runner closes that gap. It drives
 * the real `/api/council` endpoint with the same payload the map UI sends,
 * captures every route the council proposes, measures all of them with the one
 * metrics module, and writes the result out as a committed fixture. That
 * fixture is the baseline a deterministic route builder has to beat.
 *
 *   # start the app first:  npm run dev
 *   node scripts/eval-routes.mjs --list
 *   node scripts/eval-routes.mjs --selections adjacent-scarborough-trio
 *   node scripts/eval-routes.mjs --all --out src/server/__fixtures__/baseline-routes.json
 *   node scripts/eval-routes.mjs --recompute        # re-score a recorded baseline
 *
 * Needs a `.env` with SUPABASE_URL / SUPABASE_KEY (census population) and
 * ANTHROPIC_API_KEY (the council itself, read by the server, not by this script).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..");
const SRC_URL = pathToFileURL(join(WEB, "src") + "/").href;

/**
 * Load the app's own TypeScript straight into this script.
 *
 * 📖 Learn: Node ≥ 22 strips TypeScript types on import, but it resolves
 * specifiers the way Node does — it knows nothing about the `~/*` alias in
 * tsconfig, will not guess a missing `.ts` extension, and wants an import
 * attribute on JSON. Three tiny resolve/load hooks teach it all three, which
 * means the runner measures with the EXACT module the server and the tests use,
 * with no build step, no bundler and no duplicated copy of the metrics.
 */
registerHooks({
  resolve(spec, ctx, next) {
    // `server-only` is a Next.js marker that throws outside a server bundle.
    if (spec === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
    const base = spec.startsWith("~/")
      ? SRC_URL + spec.slice(2)
      : spec.startsWith(".") && ctx.parentURL
        ? new URL(spec, ctx.parentURL).href
        : null;
    if (base && !/\.(ts|tsx|js|mjs|json)$/.test(base)) {
      for (const ext of [".ts", ".tsx", ".js", "/index.ts"]) {
        if (existsSync(new URL(base + ext))) return { url: base + ext, shortCircuit: true };
      }
    }
    if (base && spec.startsWith("~/")) return { url: base, shortCircuit: true };
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.endsWith(".json")) {
      return { format: "json", source: readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
    }
    return next(url, ctx);
  },
});

const { computeRouteMetrics, evaluateGate, populationSourceFromBlocks, throughPathKm } =
  await import("../src/server/route-metrics.ts");
const { ROUTES } = await import("../src/app/map/transit-data.ts");

// ── arguments ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const GOLDEN = JSON.parse(
  readFileSync(join(WEB, "src/server/__fixtures__/golden-selections.json"), "utf8"),
);
const OUT = resolve(WEB, opt("out", "src/server/__fixtures__/baseline-routes.json"));
const BASE = opt("base", "http://localhost:3000").replace(/\/$/, "");
const WALK_KM = GOLDEN.walkKm ?? 0.8;

if (flag("list")) {
  for (const s of GOLDEN.selections) {
    console.log(`${s.id.padEnd(28)} ${String(s.codes.length).padStart(2)} areas  ${s.shape.padEnd(10)} ${s.names.join(", ")}`);
  }
  process.exit(0);
}

// ── .env ──────────────────────────────────────────────────────────────────────

/**
 * Minimal .env reader. The repo keeps ONE .env at the root (see .gitignore);
 * we only need the two Supabase keys, so a five-line parser beats pulling a
 * dependency into a script that must also run in CI-less environments.
 */
function loadEnv() {
  for (const p of [join(WEB, ".env"), join(WEB, "..", ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
loadEnv();

// ── population ────────────────────────────────────────────────────────────────

const TORONTO_BBOX = [-79.75, 43.55, -79.05, 43.95]; // mirrors map-data/geo.ts
const POP_CACHE = join(WEB, ".next/cache/eval-routes-census.json");

/**
 * The census raster, fetched the same way `map-data/census.ts` fetches it:
 * clipped to the Toronto bbox, population > 0, paged at 1,000 rows.
 *
 * I/O lives HERE, in the runner — never in the metrics module. That separation
 * is what lets the unit tests score routes against fixtures with no network.
 */
async function loadCensusBlocks() {
  if (existsSync(POP_CACHE)) {
    const cached = JSON.parse(readFileSync(POP_CACHE, "utf8"));
    console.log(`census: ${cached.length.toLocaleString()} blocks (cached)`);
    return cached;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_KEY missing — census population unavailable");

  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key);
  const [west, south, east, north] = TORONTO_BBOX;
  const blocks = [];
  for (let offset = 0; blocks.length < 80_000; offset += 1000) {
    const { data, error } = await supabase
      .from("pop_data")
      .select("longitude, latitude, population")
      .gte("latitude", south).lte("latitude", north)
      .gte("longitude", west).lte("longitude", east)
      .gt("population", 0)
      .range(offset, offset + 999);
    if (error) throw new Error(`pop_data: ${error.message}`);
    if (!data?.length) break;
    for (const r of data) blocks.push({ coords: [r.longitude, r.latitude], population: r.population });
    if (data.length < 1000) break;
  }
  mkdirSync(dirname(POP_CACHE), { recursive: true });
  writeFileSync(POP_CACHE, JSON.stringify(blocks));
  console.log(`census: ${blocks.length.toLocaleString()} blocks fetched`);
  return blocks;
}

// ── the live council ──────────────────────────────────────────────────────────

/** The existing network, exactly as the map's default state sends it. */
const EXISTING_STOPS = ROUTES.flatMap((r) =>
  r.stops.map((s) => ({ name: s.name, coords: s.coords, route: r.name })),
);

/**
 * POST one selection to /api/council and drain the SSE stream.
 *
 * The council streams for minutes and the route we want can arrive at any
 * point, so we keep every route-bearing event rather than waiting for the last.
 */
async function runCouncil(selection) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/council`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      neighbourhoods: selection.names,
      stations: [],
      line_type: null,
      context: null,
      existing_lines: EXISTING_STOPS,
      provider: "anthropic",
      randomize_speaking_order: false, // reproducibility beats variety here
    }),
  });
  if (!res.ok) throw new Error(`/api/council → HTTP ${res.status}`);

  const events = [];
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch {
        /* a partial frame at the tail — the next chunk completes it */
      }
    }
  }
  return { events, durationS: Math.round((Date.now() - started) / 10) / 100 };
}

// ── scoring ───────────────────────────────────────────────────────────────────

function areasFor(selection) {
  return selection.codes.map((code) => {
    const a = GOLDEN.areas[code];
    if (!a) throw new Error(`golden fixture references unknown area ${code}`);
    return { name: a.name, ring: a.ring };
  });
}

function score(route, selection, population) {
  const metrics = computeRouteMetrics({
    stops: route.stops.map((s) => ({ name: s.name, coords: s.coords })),
    mode: "subway",
    population,
    existingStops: EXISTING_STOPS,
    areas: areasFor(selection),
    walkKm: WALK_KM,
  });
  return { metrics, gate: evaluateGate(metrics) };
}

/** One line a human can read at a glance — the shape of the failure, in numbers. */
function summarise(label, m) {
  const g = m.geometry;
  return (
    `    ${label.padEnd(18)} ${String(m.stopCount).padStart(2)} stops  ${g.totalKm.toFixed(1).padStart(5)} km  ` +
    `sinuosity ${g.sinuosity.toFixed(2).padStart(5)}  worst turn ${g.maxTurnDeg.toFixed(0).padStart(3)}°  ` +
    `rev ${g.reversals}  cross ${g.selfIntersections}  spacing ${g.spacingViolations.tooClose + g.spacingViolations.tooFar}  ` +
    `minCov ${(m.coverage.minAreaCoverage * 100).toFixed(0).padStart(3)}%  ` +
    `${Math.round(m.efficiency.netNewPopPerBn).toLocaleString().padStart(7)} net-new/$B`
  );
}

// ── main ──────────────────────────────────────────────────────────────────────

const population = populationSourceFromBlocks(await loadCensusBlocks());

if (flag("recompute")) {
  // Re-score routes already on disk. Used when a metric definition changes:
  // the recorded model output is the expensive part, not the arithmetic.
  const baseline = JSON.parse(readFileSync(OUT, "utf8"));
  for (const run of baseline.runs) {
    const selection = GOLDEN.selections.find((s) => s.id === run.selectionId);
    for (const r of run.routes) Object.assign(r, score(r.route, selection, population));
    console.log(`${run.selectionId}:`);
    for (const r of run.routes) console.log(summarise(r.label, r.metrics));
  }
  baseline.recomputedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`\nrewrote ${OUT}`);
  process.exit(0);
}

const wanted = flag("all")
  ? GOLDEN.selections
  : opt("selections", "")
      .split(",")
      .filter(Boolean)
      .map((id) => {
        const s = GOLDEN.selections.find((x) => x.id === id);
        if (!s) throw new Error(`unknown selection "${id}" — try --list`);
        return s;
      });

if (wanted.length === 0) {
  console.error("nothing to do: pass --selections <id,...> or --all (see --list)");
  process.exit(2);
}

const runs = [];
const failures = [];
for (const selection of wanted) {
  console.log(`\n${selection.id} (${selection.codes.length} areas, ${selection.shape})`);
  let events, durationS;
  try {
    ({ events, durationS } = await runCouncil(selection));
  } catch (err) {
    console.error(`  FAILED: ${String(err)}`);
    failures.push(selection.id);
    runs.push({ selectionId: selection.id, error: String(err) });
    continue;
  }

  // Every route the council put on the wire, in order. `route_update` round 1
  // is Alex Chen's proposal, round 2 is Jordan Park's; `route_final` is what
  // the commission actually shipped to the map.
  const routes = [];
  for (const e of events) {
    if (e.type === "route_update" && e.route?.stops?.length) {
      routes.push({ label: e.round === 2 ? "Jordan Park" : "Alex Chen", event: e.type, route: e.route });
    } else if (e.type === "route_final" && e.route?.stops?.length) {
      routes.push({ label: "commission final", event: e.type, route: e.route, prScore: e.pr_score ?? null });
    }
  }
  for (const r of routes) Object.assign(r, score(r.route, selection, population));

  const statuses = events.filter((e) => e.type === "status").map((e) => e.text);
  console.log(`  ${durationS}s, ${events.length} events, ${routes.length} routes`);
  for (const r of routes) console.log(summarise(r.label, r.metrics));
  const repairs = statuses.filter((t) => /repair/i.test(t));
  for (const t of repairs) console.log(`    repair: ${t}`);

  // The council reports its own failures as status text and still closes the
  // stream cleanly, so a run that produced nothing looks exactly like a fast
  // success. Say so loudly: a silently empty baseline is worse than no baseline.
  const fatal = statuses.filter((t) => /^(Fatal error|Council graph error)/.test(t));
  for (const t of fatal) console.error(`  COUNCIL ERROR: ${t}`);
  if (routes.length === 0) {
    console.error(`  NO ROUTES RECORDED for ${selection.id} — not written to the baseline.`);
    failures.push(selection.id);
    runs.push({ selectionId: selection.id, error: fatal[0] ?? "council produced no route", statuses });
    continue;
  }

  runs.push({
    selectionId: selection.id,
    shape: selection.shape,
    areaCount: selection.codes.length,
    areaNames: selection.names,
    durationS,
    throughPathKm: throughPathKm(areasFor(selection)),
    repairs,
    routes,
  });
}

const baseline = {
  $comment:
    "Recorded output of the LIVE council for the golden selections, scored by src/server/route-metrics.ts. " +
    "This is the baseline a deterministic route builder has to beat - regenerate with scripts/eval-routes.mjs, " +
    "re-score without re-running the model with --recompute.",
  recordedAt: new Date().toISOString(),
  base: BASE,
  walkKm: WALK_KM,
  existingStopCount: EXISTING_STOPS.length,
  censusBlockCount: population.blocks().length,
  runs,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(baseline, null, 2) + "\n");
console.log(`\nwrote ${OUT}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} selection(s) produced no route: ${failures.join(", ")}`);
  process.exit(1);
}
