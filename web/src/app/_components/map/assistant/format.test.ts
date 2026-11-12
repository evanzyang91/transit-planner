import { describe, expect, it } from "vitest";
import { formatCost, formatKm, formatPopulation, safeHexColor } from "./format";

describe("draft card formatting", () => {
  it("formats distances", () => {
    expect(formatKm(0.85)).toBe("0.85 km");
    expect(formatKm(12.345)).toBe("12.3 km");
    expect(formatKm(120.4)).toBe("120 km");
    expect(formatKm(undefined)).toBe("—");
  });

  it("formats costs given in billions", () => {
    expect(formatCost(1.234)).toBe("$1.2B");
    expect(formatCost(0.45)).toBe("$450M");
    expect(formatCost(0.0002)).toBe("$1M");
    expect(formatCost(Number.NaN)).toBe("—");
  });

  it("formats population counts", () => {
    expect(formatPopulation(950)).toBe("950");
    expect(formatPopulation(85_400)).toBe("85k");
    expect(formatPopulation(1_234_567)).toBe("1.2M");
    expect(formatPopulation(undefined)).toBe("—");
  });

  it("only lets plain hex colours into a style", () => {
    expect(safeHexColor("#0EA5E9")).toBe("#0EA5E9");
    expect(safeHexColor("#abc")).toBe("#abc");
    expect(safeHexColor("red")).toBe("#14b8a6");
    expect(safeHexColor("url(https://evil.example/x.png)")).toBe("#14b8a6");
  });
});
