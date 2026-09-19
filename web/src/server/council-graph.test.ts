import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { resolveBriefNeighbourhood } from "./council-graph";

/**
 * The UI sends the City's 158 official neighbourhood names (AREA_NAME in the
 * public geojson) to the server. Before this fix, buildDataBrief resolved
 * those names against a 16-entry hand-drawn catalogue, so 155/158 came back
 * "not in the neighbourhood catalogue" — and the model placed those areas
 * from memory instead of the real polygon. This test pins resolveBriefNeighbourhood
 * (the function buildDataBrief actually calls) against every real AREA_NAME.
 */
const geojsonPath = fileURLToPath(
  new URL("../../public/Neighbourhoods - 4326.geojson", import.meta.url),
);
const NEIGHBOURHOODS_GEOJSON = JSON.parse(readFileSync(geojsonPath, "utf8")) as {
  features: Array<{ properties: { AREA_NAME: string } }>;
};
const AREA_NAMES = NEIGHBOURHOODS_GEOJSON.features.map((f) => f.properties.AREA_NAME);

describe("resolveBriefNeighbourhood", () => {
  it("has all 158 official City neighbourhoods in the fixture", () => {
    expect(AREA_NAMES.length).toBe(158);
  });

  it("resolves every official AREA_NAME the UI can send", () => {
    const unresolved = AREA_NAMES.filter((name) => resolveBriefNeighbourhood(name) === null);
    expect(unresolved).toEqual([]);
  });

  it("returns a real ring (not a stub) for a downtown and a far-out example", () => {
    const downtown = resolveBriefNeighbourhood("Yonge-Bay Corridor");
    const farOut = resolveBriefNeighbourhood("Woburn North");
    expect(downtown?.ring.length).toBeGreaterThan(2);
    expect(farOut?.ring.length).toBeGreaterThan(2);
  });

  it("returns null for a name that is not a real neighbourhood", () => {
    expect(resolveBriefNeighbourhood("Definitely Not A Real Place")).toBeNull();
  });
});
