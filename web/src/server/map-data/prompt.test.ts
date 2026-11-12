import { describe, expect, it } from "vitest";

import type { MapUiSnapshot } from "~/lib/map-assistant-protocol";
import { buildCoreKnowledge } from "~/lib/project-knowledge";
import { buildNetwork } from "./network";
import { buildMapAssistantPrompt } from "./prompt";
import { MAP_TOOLS } from "./tools";

/**
 * The prompt is split so the provider can cache the big static part. The one
 * property that makes caching work — the static text never changes between
 * requests — is invisible when reading the code, so it is pinned here.
 */

const stop = (name: string, lng: number, lat: number) => ({ name, coords: [lng, lat] as [number, number] });

const NETWORK_A = buildNetwork([
  { id: "streetcar-501", name: "Queen", shortName: "501", type: "streetcar", stops: [stop("A", -79.4, 43.65), stop("B", -79.39, 43.65)] },
  { id: "line-1", name: "Yonge–University", shortName: "1", type: "subway", stops: [stop("C", -79.38, 43.66), stop("D", -79.38, 43.67)] },
  { id: "custom-0", name: "Zebra Express", type: "bus", stops: [stop("E", -79.3, 43.7), stop("F", -79.31, 43.7)] },
]);
const NETWORK_B = buildNetwork([]);

const UI: MapUiSnapshot = {
  v: 1,
  layers: [{ id: "transitDesert", on: true }],
  viewport: { center: [-79.38, 43.65], zoom: 13, bounds: [-79.42, 43.63, -79.34, 43.67], neighbourhoodAtCenter: "Moss Park" },
};

describe("buildMapAssistantPrompt — static part", () => {
  it("is byte-identical whatever the request (so prompt caching can hit)", () => {
    const a = buildMapAssistantPrompt({
      network: NETWORK_A,
      coverage: { pctPopulationServed: 61.5, servedPopulation: 1_700_000, totalPopulation: 2_760_000 },
      ui: UI,
      today: "Thursday 2026-11-12",
    });
    const b = buildMapAssistantPrompt({ network: NETWORK_B, coverage: null, ui: null, today: new Date("2031-01-01T12:00:00Z") });
    expect(a.staticPrompt).toBe(b.staticPrompt);
  });

  it("contains none of the request's data", () => {
    const { staticPrompt } = buildMapAssistantPrompt({ network: NETWORK_A, coverage: null, ui: UI, today: "Thursday 2026-11-12" });
    for (const requestOnly of ["Zebra Express", "2026-11-12", "Moss Park", "custom-0"]) {
      expect(staticPrompt).not.toContain(requestOnly);
    }
  });

  it("carries the whole core knowledge pack", () => {
    expect(buildMapAssistantPrompt({ network: NETWORK_B, coverage: null }).staticPrompt).toContain(buildCoreKnowledge());
  });

  it("tells the model when to use every tool it is given", () => {
    const { staticPrompt } = buildMapAssistantPrompt({ network: NETWORK_B, coverage: null });
    for (const tool of MAP_TOOLS) expect(staticPrompt, tool.name).toContain(tool.name);
  });

  it("routes explanations away from the old draw-only rule, and keeps the UI labels it cites", () => {
    const { staticPrompt } = buildMapAssistantPrompt({ network: NETWORK_B, coverage: null });
    expect(staticPrompt).not.toContain("If you didn't draw it, don't say it");
    expect(staticPrompt).toContain("at most 6 sentences or 6 short bullets");
    expect(staticPrompt).toContain('"Clear all" next to the map-findings count');
    expect(staticPrompt).toContain("Settings ⚙ → Reset project");
    expect(staticPrompt).toContain('"Add to map"');
    expect(staticPrompt).toContain("Never narrate intentions");
  });
});

describe("buildMapAssistantPrompt — dynamic part", () => {
  it("has the date, the plan (custom lines first, with ids), coverage and the bus caveat", () => {
    const { dynamicContext } = buildMapAssistantPrompt({
      network: NETWORK_A,
      coverage: { pctPopulationServed: 61.5, servedPopulation: 1_700_000, totalPopulation: 2_760_000 },
      ui: UI,
      today: "Thursday 2026-11-12",
    });
    expect(dynamicContext).toContain("Today: Thursday 2026-11-12.");
    expect(dynamicContext).toContain("61.5% of Toronto's census population (1,700,000 of 2,760,000)");
    expect(dynamicContext).toContain("TTC bus routes the user hasn't loaded");
    const custom = dynamicContext.indexOf("Zebra Express (bus, custom line, 2 stops) [id custom-0]");
    const subway = dynamicContext.indexOf("Line 1 Yonge–University (subway, 2 stops) [id line-1]");
    const streetcar = dynamicContext.indexOf("501 Queen (streetcar, 2 stops) [id streetcar-501]");
    expect(custom).toBeGreaterThan(-1);
    expect(custom).toBeLessThan(subway);
    expect(subway).toBeLessThan(streetcar);
  });

  it("renders what the user sees, or says it is unknown", () => {
    const withUi = buildMapAssistantPrompt({ network: NETWORK_A, coverage: null, ui: UI }).dynamicContext;
    expect(withUi).toContain("WHAT THE USER CURRENTLY SEES:");
    expect(withUi).toContain("Transit deserts [transitDesert]");
    expect(withUi).toContain("centred on Moss Park");
    const withoutUi = buildMapAssistantPrompt({ network: NETWORK_A, coverage: null }).dynamicContext;
    expect(withoutUi).toContain("UI state unknown");
    expect(withoutUi).toContain("call network_coverage before making any coverage claim");
  });

  it("says so explicitly when the map is empty", () => {
    expect(buildMapAssistantPrompt({ network: NETWORK_B, coverage: null }).dynamicContext).toContain(
      "(none — the user's map is empty",
    );
  });

  it("formats a Date in Toronto time", () => {
    const { dynamicContext } = buildMapAssistantPrompt({
      network: NETWORK_B,
      coverage: null,
      today: new Date("2026-11-12T15:00:00Z"),
    });
    expect(dynamicContext).toContain("Today: Thursday 2026-11-12.");
  });
});
