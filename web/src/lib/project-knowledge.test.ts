import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { HISTORY_LIMITS, MAP_LAYER_IDS } from "./map-assistant-protocol";
import { MODE_FACTORS } from "./ridership-model";
import { MODE_COSTS } from "~/server/route-metrics";
import { DEFAULT_GAP_THRESHOLD_KM } from "~/server/map-data/gaps";
import {
  KNOWLEDGE_SECTIONS,
  LOOKUP_TOPICS,
  OVERLAY_CATALOG,
  QUOTED_CONSTANTS,
  buildCoreKnowledge,
  buildDocsCorpus,
  lookupKnowledge,
} from "./project-knowledge";

/**
 * The knowledge pack is prose, so the risk is not a crash — it is the text
 * quietly going stale while the app changes underneath it. These tests are the
 * drift alarm: every number the text quotes is compared with the code that
 * owns it, and every UI label it tells users to click must still exist.
 *
 * Constants that are exported are imported. Constants that are private to
 * their module are checked against the module's SOURCE TEXT with a regex —
 * blunt, but it fails loudly the day someone edits the value, which is the
 * whole point.
 */

const SRC = fileURLToPath(new URL("..", import.meta.url)); // web/src

function source(relPath: string): string {
  return readFileSync(join(SRC, relPath), "utf8");
}

/** Every .ts/.tsx file under a directory, concatenated (labels may move between components). */
function sourceTree(relDir: string): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".test.ts")) out.push(readFileSync(full, "utf8"));
    }
  };
  walk(join(SRC, relDir));
  return out.join("\n");
}

/**
 * Read a `{ key: number, … }` object literal out of source text, e.g. the
 * SPEED table in simulation.ts, as a plain Record — so values are compared as
 * numbers (1.0 === 1) rather than as fiddly strings.
 */
function parseNumberMap(objectBody: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const match of objectBody.matchAll(/(\w+):\s*(-?[\d.]+)/g)) {
    out[match[1]!] = Number(match[2]);
  }
  return out;
}

const core = buildCoreKnowledge();
const Q = QUOTED_CONSTANTS;

describe("OVERLAY_CATALOG", () => {
  it("has a complete entry for every layer id the UI snapshot can report", () => {
    for (const id of MAP_LAYER_IDS) {
      const entry = OVERLAY_CATALOG[id];
      expect(entry, id).toBeDefined();
      expect(entry.label.trim(), `${id}.label`).not.toBe("");
      expect(entry.whatItShows.trim(), `${id}.whatItShows`).not.toBe("");
      expect(entry.colours.trim(), `${id}.colours`).not.toBe("");
      expect(entry.howToToggle.trim(), `${id}.howToToggle`).not.toBe("");
    }
  });

  it("has no entries for ids the protocol doesn't know", () => {
    expect(Object.keys(OVERLAY_CATALOG).sort()).toEqual([...MAP_LAYER_IDS].sort());
  });

  it("uses the exact label + subtitle pairs shown in the Layers menu", () => {
    const components = sourceTree("app/_components");
    for (const id of MAP_LAYER_IDS) {
      const { label, subtitle } = OVERLAY_CATALOG[id];
      // Dynamic subtitles ("<n> annotations…") and overlays that aren't in the menu are skipped.
      if (subtitle === "" || subtitle.includes("<")) continue;
      expect(components, `${id}: label: "${label}", sub: "${subtitle}"`).toContain(
        `label: "${label}", sub: "${subtitle}"`,
      );
    }
  });

  it("is described, with its id, in the always-on core text", () => {
    for (const id of MAP_LAYER_IDS) {
      expect(core).toContain(`${OVERLAY_CATALOG[id].label} [${id}]`);
    }
  });
});

describe("QUOTED_CONSTANTS match the code that owns them", () => {
  it("route-metrics MODE_COSTS (the documented single source of truth for cost)", () => {
    for (const mode of ["subway", "lrt", "streetcar", "bus"] as const) {
      expect(Q.costPerKmBn[mode], mode).toBe(MODE_COSTS[mode].perKmBn);
      expect(Q.costPerStationBn[mode], mode).toBe(MODE_COSTS[mode].perStationBn);
    }
  });

  it("every cost panel uses the shared cost model, as the 'costs' topic says", () => {
    const components = sourceTree("app/_components");
    expect(components).toContain("costModeFor(parsed.type)"); // council result card
    expect(components).toContain("costBn(km, route.stops.length, costMode)"); // Feasibility Doc
    expect(components).toContain("alignmentCostBn("); // Cost Estimator
    expect(components).not.toContain("const costPerKm =");
  });

  it("gap engine (gaps.ts)", () => {
    expect(Q.gapThresholdKm).toBe(DEFAULT_GAP_THRESHOLD_KM);
    const gaps = source("server/map-data/gaps.ts");
    expect(gaps).toMatch(new RegExp(`POCKET_RADIUS_KM = ${Q.gapPocketRadiusKm};`));
    expect(gaps).toMatch(new RegExp(`MIN_AREA_POPULATION = ${Q.gapMinPopulation};`));
    expect(gaps).toMatch(new RegExp(`MAX_AREAS = ${Q.gapMaxAreas};`));
  });

  it("coverage measure radius (census.ts) and Route panel station radii (TransitMap.tsx)", () => {
    expect(source("server/map-data/census.ts")).toContain(`walkKm = ${Q.coverageWalkKm}`);
    expect(sourceTree("app/_components")).toContain(
      `type === "streetcar" || type === "bus" ? ${Q.stationPopRadiusKm.surface} : ${Q.stationPopRadiusKm.rapid}`,
    );
  });

  it("simulation engine (simulation.ts) and the API's seed default", () => {
    const sim = source("server/simulation.ts");
    expect(sim).toMatch(new RegExp(`ACCESS_WALK_M\\s*=\\s*${Q.simAccessWalkM};`));
    expect(sim).toMatch(new RegExp(`WALK_TRANSFER_M\\s*=\\s*${Q.simTransferWalkM};`));
    const speedTable = parseNumberMap(/const SPEED[^=]*=\s*\{([^}]*)\}/.exec(sim)?.[1] ?? "");
    expect(speedTable).toEqual(Q.simSpeedsKmh);
    expect(source("app/api/simulation/route.ts")).toContain(`seed: body.seed ?? ${Q.simSeed}`);
  });

  it("council graph (council-graph.ts)", () => {
    const council = source("server/council-graph.ts");
    expect(council).toContain(`const MAX_REVISIONS = ${Q.councilMaxRevisions};`);
    expect(council).toContain(`agentCount: ${Q.councilSimAgents},`);
  });

  it("client layer defaults (annotations TTL, vehicle polling, catchment/disruption radii, desert weights)", () => {
    expect(source("app/_components/map/AIAnnotationsContext.tsx")).toContain(
      `TTL_MS = ${Q.aiFindingsTtlHours} * 60 * 60 * 1000`,
    );
    expect(source("app/_components/map/hooks/useLiveVehicles.ts")).toContain(
      `${Q.liveVehiclePollSeconds}_000`,
    );
    const components = sourceTree("app/_components");
    expect(components).toContain(`[catchmentRadius, setCatchmentRadius] = useState(${Q.catchmentDefaultM})`);
    expect(components).toContain(`[disruptionRadius, setDisruptionRadius] = useState(${Q.disruptionDefaultM})`);
    const desertWeights = parseNumberMap(
      /const MODE_WEIGHT[^=]*=\s*\{([^}]*)\}/.exec(source("app/_components/map/hooks/useTransitDesert.ts"))?.[1] ?? "",
    );
    expect(desertWeights).toEqual(Q.desertModeWeights);
  });
});

describe("the known issues the text describes are still true", () => {
  // The knowledge pack states these bugs truthfully. When someone FIXES one,
  // the matching test fails on purpose: update KNOWN ISSUES / the lookup
  // topic in project-knowledge.ts, then update or delete the pin here.
  const components = sourceTree("app/_components");

  it("Traffic's subtitle still claims live Mapbox traffic (it's a stored table)", () => {
    expect(components).toContain('label: "Traffic", sub: "Current Mapbox traffic"');
  });

  it("Coverage Zones still draw pixel-sized circles labelled 500 m", () => {
    expect(components).toContain('sub: "500 m radius per stop"');
    expect(components).toMatch(/"circle-radius":\s*\[\s*"interpolate", \["linear"\], \["zoom"\],/);
  });

  it("the Simulate panel's equity text and agent legend still say what the text quotes", () => {
    const panel = source("app/_components/map/SimulationPanel.tsx");
    expect(panel).toContain("Time savings weighted by transit dependency");
    expect(components).toContain('bg-teal-500" /> Mid-income');
  });

  it("the simulation baseline is still the built-in network with every bus route", () => {
    expect(source("server/simulation.ts")).toMatch(/\.\.\.ROUTES\.filter\(\(r\) => r\.type === "streetcar"\),\s*\.\.\.BUS_ROUTES,/);
  });
});

describe("numbers imported from client-safe modules show up in the text", () => {
  it("ridership mode factors", () => {
    const text = lookupKnowledge("ridership_model");
    for (const factor of Object.values(MODE_FACTORS)) expect(text).toContain(String(factor));
  });

  it("chat history limit", () => {
    expect(core).toContain(`last ${HISTORY_LIMITS.maxUserTurns} questions`);
  });
});

describe("UI labels the knowledge tells users to click still exist", () => {
  // Quoted button / menu labels from the core how-tos. If a component renames
  // one of these, the assistant would send users looking for a ghost button.
  const LABELS = [
    "New Line",
    "Snap to roads",
    "Add portal",
    "View timetable",
    "Delete line",
    "Delete stop",
    "Remove station",
    "Add transfer to:",
    "Map overlays",
    "Pin to toolbar",
    "Measure distance",
    "Load custom overlay…",
    "Run Baseline Simulation",
    "Run Scenario Comparison",
    "Animate agents on map",
    "Ask AI about this segment",
    "Ask AI about here",
    "Save new plan",
    "Merge & import",
    "Replace & import",
    "Copy shareable link",
    "Reset project",
    "Restore default network",
    "Empty map",
    "Export first",
    "Generate Route",
    "View Council",
    "Randomize council speaking order",
    "Clear all",
    "Add to map", // the draft-line confirm card — the prompt and propose_line's note cite it
  ];

  it.each(LABELS)("%s", (label) => {
    expect(sourceTree("app/_components")).toContain(label);
  });
});

describe("tiers and builders", () => {
  it("keeps the always-on core inside its token budget (~2.5–3.5k tokens)", () => {
    // ≈4 characters per token for this kind of English text.
    expect(core.length).toBeGreaterThan(8_000);
    expect(core.length).toBeLessThan(14_000);
  });

  it("is deterministic — identical on every call, so it can live in a cached prompt prefix", () => {
    expect(buildCoreKnowledge()).toBe(core);
    expect(buildDocsCorpus()).toBe(buildDocsCorpus());
  });

  it("has unique section ids, and one lookup section per LOOKUP_TOPIC", () => {
    const ids = KNOWLEDGE_SECTIONS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    const lookupIds = KNOWLEDGE_SECTIONS.filter((s) => s.tier === "lookup").map((s) => s.id);
    expect(lookupIds).toEqual([...LOOKUP_TOPICS]);
  });

  it("returns every lookup topic, titled, and explains unknown topics", () => {
    for (const topic of LOOKUP_TOPICS) {
      const section = KNOWLEDGE_SECTIONS.find((s) => s.id === topic)!;
      const text = lookupKnowledge(topic);
      expect(text.startsWith(section.title.toUpperCase())).toBe(true);
      expect(text.length).toBeGreaterThan(200);
    }
    const unknown = lookupKnowledge("weather");
    expect(unknown).toContain("Unknown topic");
    for (const topic of LOOKUP_TOPICS) expect(unknown).toContain(topic);
  });

  it("gives the docs chat the core plus every lookup section", () => {
    const corpus = buildDocsCorpus();
    expect(corpus).toContain(core);
    for (const section of KNOWLEDGE_SECTIONS) expect(corpus).toContain(section.body);
  });

  it("never leaks a template placeholder or 'undefined' into the text", () => {
    const corpus = buildDocsCorpus();
    expect(corpus).not.toContain("${");
    expect(corpus).not.toMatch(/\bundefined\b|\bNaN\b/);
  });

  it("stays client-safe (no server-only imports)", () => {
    const own = source("lib/project-knowledge.ts");
    expect(own).not.toMatch(/from\s+["']server-only["']|import\s+["']server-only["']/);
    expect(own).not.toMatch(/from\s+["']~\/server\//);
  });
});
