import { describe, expect, it } from "vitest";
import type { DraftLine } from "~/lib/map-assistant-protocol";
import {
  DRAFT_PREVIEW_COLOR,
  autoShortName,
  coordsBounds,
  draftPreviewGeoJSON,
  draftToRoute,
  nextCustomLineId,
  normalizeHexColor,
  validateDraftLine,
} from "./draft-line";

function draft(overrides: Partial<DraftLine> = {}): DraftLine {
  return {
    draftId: "draft-1",
    name: "Eglinton East LRT",
    type: "lrt",
    color: "#F97316",
    stops: [
      { name: "Kennedy", coords: [-79.2637, 43.7325] },
      { name: "  Midland  ", coords: [-79.2577, 43.7383] },
      { name: "", coords: [-79.2269, 43.7465] },
    ],
    stats: { lengthKm: 4.2, stopCount: 3, avgSpacingKm: 2.1 },
    rationale: "Fills the gap east of Kennedy.",
    ...overrides,
  };
}

describe("autoShortName (same rule as the New Line modal)", () => {
  it("uses the first letters of the first two words", () => {
    expect(autoShortName("Eglinton East LRT")).toBe("EE");
    expect(autoShortName("waterfront   line")).toBe("WL");
  });
  it("uses the first two letters of a single word", () => {
    expect(autoShortName("Ontario")).toBe("ON");
    expect(autoShortName("  x ")).toBe("X");
  });
  it("never returns an empty badge", () => {
    expect(autoShortName("   ")).toBe("?");
  });
});

describe("normalizeHexColor", () => {
  it("keeps 6-digit hex (lower-cased) and expands 3-digit hex", () => {
    expect(normalizeHexColor("#F97316")).toBe("#f97316");
    expect(normalizeHexColor("#abc")).toBe("#aabbcc");
  });
  it("falls back for anything the map can't parse", () => {
    expect(normalizeHexColor("teal")).toBe(DRAFT_PREVIEW_COLOR);
    expect(normalizeHexColor("#12345")).toBe(DRAFT_PREVIEW_COLOR);
    expect(normalizeHexColor("rgb(1,2,3)", "#000000")).toBe("#000000");
  });
});

describe("validateDraftLine", () => {
  it("accepts a normal draft", () => {
    expect(validateDraftLine(draft())).toBeNull();
  });
  it("explains what is wrong with a broken one", () => {
    expect(validateDraftLine(draft({ name: "  " }))).toMatch(/no name/);
    expect(validateDraftLine(draft({ stops: [{ name: "Only", coords: [-79, 43] }] }))).toMatch(/two stops/);
    expect(validateDraftLine(draft({ type: "monorail" as DraftLine["type"] }))).toMatch(/not a line type/);
    expect(
      validateDraftLine(draft({ stops: [{ name: "A", coords: [-79, 43] }, { name: "B", coords: [500, 43] }] })),
    ).toMatch(/invalid coordinates/);
    expect(
      validateDraftLine(draft({ stops: [{ name: "A", coords: [-79, 43] }, { name: "B", coords: [Number.NaN, 43] }] })),
    ).toMatch(/invalid coordinates/);
  });
  it("rejects fields draftToRoute would crash on (e.g. a draft re-read from saved history)", () => {
    expect(validateDraftLine(draft({ color: 42 as unknown as string }))).toMatch(/no colour/);
    expect(
      validateDraftLine(
        draft({ stops: [{ name: "A", coords: [-79, 43] }, { name: null as unknown as string, coords: [-79.1, 43] }] }),
      ),
    ).toMatch(/no name/);
  });
});

describe("nextCustomLineId", () => {
  it("uses the counter when the id is free", () => {
    expect(nextCustomLineId(["line-1"], 1)).toEqual({ id: "custom-1", nextCounter: 2 });
  });
  it("skips ids a loaded plan already uses", () => {
    expect(nextCustomLineId(["custom-1", "custom-2", "custom-4"], 1)).toEqual({ id: "custom-3", nextCounter: 4 });
  });
});

describe("draftToRoute", () => {
  it("builds the same Route shape as the New Line flow, with id'd stops", () => {
    let n = 0;
    const route = draftToRoute(draft(), { id: "custom-7", makeStopId: () => `stop-${++n}` });
    expect(route).toEqual({
      id: "custom-7",
      name: "Eglinton East LRT",
      shortName: "EE",
      color: "#f97316",
      textColor: "#ffffff",
      type: "lrt",
      description: "Custom line",
      frequency: "—",
      stops: [
        { id: "stop-1", name: "Kennedy", coords: [-79.2637, 43.7325] },
        { id: "stop-2", name: "Midland", coords: [-79.2577, 43.7383] },
        // A blank stop name gets a placeholder rather than an empty label.
        { id: "stop-3", name: "Station 3", coords: [-79.2269, 43.7465] },
      ],
    });
  });

  it("does not share coordinate arrays with the draft", () => {
    const source = draft();
    const route = draftToRoute(source, { id: "custom-1", makeStopId: () => "s" });
    expect(route.stops[0]?.coords).not.toBe(source.stops[0]?.coords);
  });
});

describe("draftPreviewGeoJSON + coordsBounds", () => {
  it("draws one line through the stops and one point per stop", () => {
    const { line, stops } = draftPreviewGeoJSON(draft());
    expect(line.geometry.coordinates).toHaveLength(3);
    expect(line.properties).toEqual({ draftId: "draft-1" });
    expect(stops.features.map((feature) => String(feature.properties?.name))).toEqual(["Kennedy", "  Midland  ", ""]);
  });

  it("computes [west, south, east, north]", () => {
    expect(
      coordsBounds([
        [-79.2637, 43.7325],
        [-79.2269, 43.7465],
        [-79.3, 43.7],
      ]),
    ).toEqual([-79.3, 43.7, -79.2269, 43.7465]);
    expect(coordsBounds([])).toBeNull();
  });
});
