// Checks the benchmark items against the REAL protocol contract, so a typo
// can't sit in the dataset unnoticed: a misspelled tool name in a forbid…
// check would otherwise pass forever, because the misspelled tool never runs.
import { describe, expect, it } from "vitest";
import {
  ANNOTATION_TOOL_NAMES,
  APP_ACTION_NAMES,
  MAP_LAYER_IDS,
  PANEL_IDS,
  TOGGLEABLE_LAYER_IDS,
  toolLabel,
} from "../../src/lib/map-assistant-protocol.ts";
import { BENCHMARK_ITEMS } from "./questions.mjs";
import { resolveTurns } from "./conversation.mjs";

const CLIENT_TOOL_NAMES = [...ANNOTATION_TOOL_NAMES, ...APP_ACTION_NAMES];

/**
 * True for a tool the server knows. The contract doesn't export its label
 * table, but toolLabel() falls back to the raw name with "_" → " " for a name
 * it has no label for — so getting anything else back means the tool exists.
 */
function isKnownServerTool(name) {
  return toolLabel(name) !== name.replace(/_/g, " ");
}

/** Every client-side expectation of an item, with the tool name it refers to. */
function clientToolNamesOf(expectedOutput) {
  return [
    ...(expectedOutput.expectToolCalls ?? []).map((exp) => exp.name),
    ...(expectedOutput.forbidToolCalls ?? []).map((forb) => forb.name),
    ...(expectedOutput.expectToolCallCount ? [expectedOutput.expectToolCallCount.name] : []),
    ...(expectedOutput.expectArtifactConsistency ? [expectedOutput.expectArtifactConsistency.tool] : []),
  ];
}

function textRulesOf(expectedOutput) {
  return [...(expectedOutput.textChecks?.mustMatch ?? []), ...(expectedOutput.textChecks?.mustNotMatch ?? [])];
}

describe("benchmark items", () => {
  it("keeps all 11 original items and adds the new ones, with unique ids", () => {
    const ids = BENCHMARK_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const originalId of [
      "tool-selection-best-served",
      "tool-selection-least-served",
      "grounding-coverage-share",
      "grounding-ridership-estimate",
      "edge-case-water-pin",
      "edge-case-unknown-neighbourhood",
      "multi-turn-gap-reuse",
      "multi-turn-served-reuse",
      "output-discipline-no-clarifying-question",
      "output-discipline-draw-everything-mentioned",
      "app-action-reset-wipe",
    ]) {
      expect(ids).toContain(originalId);
    }
    for (const newId of [
      "knowledge-heatmap-visible",
      "knowledge-two-heatmaps",
      "knowledge-how-to-save",
      "action-layer-on",
      "action-focus-route",
      "action-run-simulation",
      "action-draft-line",
    ]) {
      expect(ids).toContain(newId);
    }
  });

  it("are plain JSON, because Langfuse stores them as JSON", () => {
    for (const item of BENCHMARK_ITEMS) {
      // A RegExp would come back as {}, an undefined value would vanish.
      expect(JSON.parse(JSON.stringify(item)), item.id).toStrictEqual(item);
    }
  });

  it("each have a category and at least one message to send", () => {
    for (const item of BENCHMARK_ITEMS) {
      expect(typeof item.metadata?.category, item.id).toBe("string");
      const turns = resolveTurns(item.input);
      expect(turns.length, item.id).toBeGreaterThan(0);
      for (const turn of turns) expect(typeof turn.message, item.id).toBe("string");
    }
  });

  it("only name tools the browser can actually receive in client checks", () => {
    for (const item of BENCHMARK_ITEMS) {
      for (const name of clientToolNamesOf(item.expectedOutput)) {
        expect(CLIENT_TOOL_NAMES, `${item.id}: "${name}" is not a client tool_call name`).toContain(name);
      }
    }
  });

  it("only name tools the server knows in trace checks", () => {
    for (const item of BENCHMARK_ITEMS) {
      const traceChecks = [...(item.expectedOutput.expectTrace ?? []), ...(item.expectedOutput.forbidTrace ?? [])];
      for (const check of traceChecks) {
        expect(isKnownServerTool(check.tool), `${item.id}: unknown server tool "${check.tool}"`).toBe(true);
      }
    }
  });

  it("only switch layers the assistant is allowed to toggle", () => {
    for (const item of BENCHMARK_ITEMS) {
      const layerChecks = (item.expectedOutput.expectToolCalls ?? []).filter((exp) => exp.name === "set_map_layers");
      for (const check of layerChecks) {
        for (const layer of check.argsContains?.layers ?? []) {
          expect(TOGGLEABLE_LAYER_IDS, item.id).toContain(layer.id);
        }
      }
    }
  });

  it("send well-formed ui snapshots", () => {
    for (const item of BENCHMARK_ITEMS) {
      for (const turn of resolveTurns(item.input)) {
        if (turn.ui === undefined) continue;
        const { ui } = turn;
        expect(ui.v, item.id).toBe(1);
        for (const layer of ui.layers) {
          expect(MAP_LAYER_IDS, item.id).toContain(layer.id);
          expect(typeof layer.on, item.id).toBe("boolean");
        }
        if (ui.viewport) {
          const [west, south, east, north] = ui.viewport.bounds;
          const [lng, lat] = ui.viewport.center;
          expect(west < lng && lng < east && south < lat && lat < north, `${item.id}: centre outside bounds`).toBe(true);
        }
        for (const [panel, isOpen] of Object.entries(ui.panels ?? {})) {
          if (panel === "council" || panel === "routePanel") continue; // not PanelIds
          expect(PANEL_IDS, item.id).toContain(panel);
          expect(typeof isOpen, item.id).toBe("boolean");
        }
      }
    }
  });

  it("send networkRoutes the server will accept, with custom lines listed in the ui too", () => {
    for (const item of BENCHMARK_ITEMS) {
      for (const turn of resolveTurns(item.input)) {
        for (const route of turn.networkRoutes ?? []) {
          expect(typeof route.name, item.id).toBe("string");
          expect(route.stops.length, item.id).toBeGreaterThan(1);
          for (const stop of route.stops) {
            const [lng, lat] = stop.coords;
            // Toronto, roughly — the server drops coordinates far outside it.
            expect(lng > -79.7 && lng < -79.0 && lat > 43.5 && lat < 43.9, `${item.id}: ${stop.name}`).toBe(true);
          }
          if (route.id.startsWith("custom-")) {
            const listed = turn.ui?.network?.customLines?.map((line) => line.id) ?? [];
            expect(listed, item.id).toContain(route.id);
          }
        }
      }
    }
  });

  it("only use text rules that compile", () => {
    for (const item of BENCHMARK_ITEMS) {
      for (const rule of textRulesOf(item.expectedOutput)) {
        expect(() => new RegExp(rule.pattern, rule.flags ?? ""), `${item.id}: /${rule.pattern}/`).not.toThrow();
      }
    }
  });
});

describe("action-draft-line's 'claims it was added' rules", () => {
  const draftItem = BENCHMARK_ITEMS.find((item) => item.id === "action-draft-line");
  const rules = draftItem.expectedOutput.textChecks.mustNotMatch.map((rule) => new RegExp(rule.pattern, rule.flags));
  const claimsAdded = (sentence) => rules.some((regex) => regex.test(sentence));

  it("let honest draft replies through — including ones that echo the confirm card", () => {
    for (const honest of [
      "I've drafted an Eglinton East subway line with 7 stops from Kennedy to Don Mills — review it on the card and click Add line to put it on your map.",
      "Nothing has been added yet — click Add line on the card if you want to keep it.",
      "Nothing is added to your network until you click Add line.",
      "It hasn't been created yet; confirm on the card to add the line.",
      "Once you confirm, the line will be added to your map.",
      "I haven't added the line yet — it's only a draft.",
    ]) {
      expect(claimsAdded(honest), honest).toBe(false);
    }
  });

  it("catch replies that claim the line already exists", () => {
    for (const claim of [
      "I've added a new Eglinton East subway line to your map.",
      "I’ve added the line.", // curly apostrophe
      "I have created the Eglinton East line with 7 stations.",
      "Your Eglinton East line has been added to the network.",
      "Created the Eglinton East Line from Kennedy to Don Mills.",
      "Done! The line is now added to your map.",
    ]) {
      expect(claimsAdded(claim), claim).toBe(true);
    }
  });
});
