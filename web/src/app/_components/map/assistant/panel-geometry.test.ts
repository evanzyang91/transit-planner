import { describe, expect, it } from "vitest";
import {
  avoidZones,
  clampRect,
  councilZone,
  defaultRect,
  expandedRect,
  moveRect,
  PANEL_DEFAULT_INSET,
  PANEL_MARGIN,
  PANEL_MAX_WIDTH,
  PANEL_MIN_HEIGHT,
  PANEL_MIN_WIDTH,
  parsePanelState,
  resizeFromTopLeft,
  rightRailZone,
  serializePanelState,
  type PanelRect,
} from "./panel-geometry";

const DESKTOP = { width: 1440, height: 900 };

function right(r: PanelRect) {
  return r.x + r.width;
}
function bottom(r: PanelRect) {
  return r.y + r.height;
}

describe("clampRect", () => {
  it("pulls a card that is off screen back inside the margins", () => {
    const r = clampRect({ x: 5000, y: -50, width: 400, height: 500 }, DESKTOP);
    expect(r).toEqual({ x: 1440 - 400 - PANEL_MARGIN, y: PANEL_MARGIN, width: 400, height: 500 });
  });

  it("enforces the min and max size", () => {
    expect(clampRect({ x: 100, y: 100, width: 10, height: 10 }, DESKTOP)).toMatchObject({
      width: PANEL_MIN_WIDTH,
      height: PANEL_MIN_HEIGHT,
    });
    expect(clampRect({ x: 100, y: 100, width: 5000, height: 5000 }, DESKTOP)).toMatchObject({
      width: PANEL_MAX_WIDTH,
      height: 900 - 120,
    });
  });

  it("shrinks below the minimum only when the window itself is smaller", () => {
    const phone = { width: 300, height: 360 };
    const r = clampRect({ x: 0, y: 0, width: 400, height: 600 }, phone);
    expect(r.width).toBe(300 - 2 * PANEL_MARGIN);
    expect(r.height).toBe(360 - 2 * PANEL_MARGIN);
    expect(r.x).toBe(PANEL_MARGIN);
  });
});

describe("defaultRect / expandedRect", () => {
  it("places the card in the bottom-right corner", () => {
    const r = defaultRect(DESKTOP);
    expect(right(r)).toBe(1440 - PANEL_DEFAULT_INSET);
    expect(bottom(r)).toBe(900 - PANEL_DEFAULT_INSET);
  });

  it("expands to the largest allowed size", () => {
    const r = expandedRect(DESKTOP);
    expect(r.width).toBe(PANEL_MAX_WIDTH);
    expect(r.height).toBe(900 - 120);
    expect(right(r)).toBe(1440 - PANEL_DEFAULT_INSET);
  });
});

describe("moveRect", () => {
  it("follows the pointer but stays on screen", () => {
    const start = { x: 100, y: 100, width: 384, height: 540 };
    expect(moveRect(start, 50, 20, DESKTOP)).toEqual({ ...start, x: 150, y: 120 });
    expect(moveRect(start, -500, 0, DESKTOP).x).toBe(PANEL_MARGIN);
  });
});

describe("resizeFromTopLeft", () => {
  const start = { x: 1000, y: 300, width: 384, height: 540 };

  it("grows up and left while the bottom-right corner stays put", () => {
    const r = resizeFromTopLeft(start, -100, -50, DESKTOP);
    expect(r.width).toBe(484);
    expect(r.height).toBe(590);
    expect(right(r)).toBe(right(start));
    expect(bottom(r)).toBe(bottom(start));
  });

  it("stops at the minimum size", () => {
    const r = resizeFromTopLeft(start, 1000, 1000, DESKTOP);
    expect(r).toMatchObject({ width: PANEL_MIN_WIDTH, height: PANEL_MIN_HEIGHT });
    expect(right(r)).toBe(right(start));
  });

  it("can't grow past the top of the window", () => {
    const nearTop = { x: 1000, y: 40, width: 384, height: 420 };
    const r = resizeFromTopLeft(nearTop, 0, -400, DESKTOP);
    expect(r.y).toBe(PANEL_MARGIN);
    expect(bottom(r)).toBe(bottom(nearTop));
  });
});

describe("avoidZones", () => {
  it("returns the same rectangle when nothing overlaps", () => {
    const r = { x: 100, y: 100, width: 384, height: 540 };
    expect(avoidZones(r, [rightRailZone(DESKTOP)])).toBe(r);
  });

  it("slides left of the right rail (it spans the full height, so up can't work)", () => {
    const r = defaultRect(DESKTOP);
    const moved = avoidZones(r, [rightRailZone(DESKTOP)]);
    expect(right(moved)).toBeLessThanOrEqual(rightRailZone(DESKTOP).left);
    expect(moved.y).toBe(r.y);
  });

  it("slides UP out of a short zone when that is the shorter move", () => {
    const zone = { left: 900, top: 820, right: 1440, bottom: 900 };
    const r = { x: 1000, y: 300, width: 384, height: 540 }; // bottom edge at 840
    const moved = avoidZones(r, [zone]);
    expect(moved.x).toBe(1000);
    expect(bottom(moved)).toBeLessThanOrEqual(zone.top);
  });

  it("gets out of the Council panel's way", () => {
    const zone = councilZone(DESKTOP, false);
    const moved = avoidZones(defaultRect(DESKTOP), [zone]);
    expect(right(moved)).toBeLessThanOrEqual(zone.left);
  });
});

describe("panel state storage", () => {
  it("round-trips the rectangle and the expanded flag", () => {
    const state = { rect: { x: 1, y: 2, width: 400, height: 500 }, expanded: true };
    expect(parsePanelState(serializePanelState(state))).toEqual(state);
  });

  it("rejects missing or damaged values", () => {
    expect(parsePanelState(null)).toBeNull();
    expect(parsePanelState("{oops")).toBeNull();
    expect(parsePanelState(JSON.stringify({ x: 1, y: 2 }))).toBeNull(); // the old v2 shape
  });
});
