import { describe, expect, it } from "vitest";

import {
  alignmentCostBn,
  costBn,
  costModeFor,
  formatCostBn,
  typicalMix,
  type CostMode,
} from "./cost-model";

describe("cost model", () => {
  it("prices a 10 km, 10-station subway at $6.5B", () => {
    expect(costBn(10, 10, "subway")).toBeCloseTo(6.5);
  });

  it("anchors the alignment sliders: the typical mix equals the headline formula for every mode", () => {
    const modes: CostMode[] = ["subway", "lrt", "streetcar", "bus"];
    for (const mode of modes) {
      expect(alignmentCostBn(12, 9, mode, typicalMix(mode))).toBeCloseTo(costBn(12, 9, mode));
    }
  });

  it("scales track cost by alignment relative to the typical one", () => {
    // An LRT fully in tunnel costs 5x its surface per-km rate; stations are unchanged.
    expect(alignmentCostBn(10, 0, "lrt", { tunnelPct: 100, elevatedPct: 0 })).toBeCloseTo(10 * 0.08 * 5);
    // A subway fully elevated costs 2/5 of the tunnelled rate.
    expect(alignmentCostBn(10, 0, "subway", { tunnelPct: 0, elevatedPct: 100 })).toBeCloseTo(10 * 0.5 * (2 / 5));
  });

  it("never lets tunnel + elevated exceed 100%", () => {
    const over = alignmentCostBn(10, 0, "lrt", { tunnelPct: 80, elevatedPct: 80 });
    const capped = alignmentCostBn(10, 0, "lrt", { tunnelPct: 80, elevatedPct: 20 });
    expect(over).toBeCloseTo(capped);
  });

  it("maps GO rail onto the LRT rate", () => {
    expect(costModeFor("go_train")).toBe("lrt");
    expect(costModeFor("streetcar")).toBe("streetcar");
  });

  it("formats billions and millions", () => {
    expect(formatCostBn(6.5)).toBe("$6.5B");
    expect(formatCostBn(0.45)).toBe("$450M");
    expect(formatCostBn(0.9996)).toBe("$1.0B");
  });
});
