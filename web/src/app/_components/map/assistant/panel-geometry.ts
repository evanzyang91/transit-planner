/**
 * Pure geometry for the floating Ask AI card: where it sits, how big it is,
 * and how it gets out of the way of other panels. No React, no DOM — all
 * numbers are CSS pixels relative to the viewport, so it's unit-testable.
 *
 * The idea: the user's chosen rectangle is SAVED as-is. What is SHOWN is that
 * rectangle after (1) fitting it into the current window and (2) sliding it
 * away from panels that are open right now. Because the saved rectangle never
 * changes when a side panel opens, the card slides back by itself when the
 * panel closes (the old version slid left and stayed there).
 */

export interface PanelRect {
  x: number; // left edge
  y: number; // top edge
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

/** A screen area the card should not cover (e.g. the Council panel). */
export interface AvoidZone {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Gap kept between the card and the window edge. */
export const PANEL_MARGIN = 8;
export const PANEL_MIN_WIDTH = 320;
export const PANEL_MIN_HEIGHT = 380;
export const PANEL_MAX_WIDTH = 720;
/** The card never gets taller than the window minus this (keeps the top toolbar visible). */
export const PANEL_HEIGHT_RESERVE = 120;
export const PANEL_DEFAULT_WIDTH = 384;
export const PANEL_DEFAULT_HEIGHT = 540;
/** Distance from the bottom-right corner for the default (and expanded) placement. */
export const PANEL_DEFAULT_INSET = 24;
/** Gap kept between the card and a panel it is avoiding. */
const AVOID_GAP = 12;

/**
 * Width of the right rail (Sim / Plans / Route / Generated panels plus their
 * margins). Empirical value carried over from the old AIChatPanel: those
 * panels are ~330 px wide at right: 24 px.
 */
export const RIGHT_RAIL_RESERVED = 378;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Smallest and largest size allowed in this window (tiny windows win over the minimums). */
export function sizeLimits(viewport: Viewport) {
  const maxWidth = Math.max(0, Math.min(PANEL_MAX_WIDTH, viewport.width - 2 * PANEL_MARGIN));
  const fitHeight = Math.max(0, viewport.height - 2 * PANEL_MARGIN);
  // Normally "window minus the reserve", but never forced below the minimum
  // height while the window can still fit it.
  const maxHeight = Math.max(Math.min(PANEL_MIN_HEIGHT, fitHeight), viewport.height - PANEL_HEIGHT_RESERVE);
  return {
    minWidth: Math.min(PANEL_MIN_WIDTH, maxWidth),
    maxWidth,
    minHeight: Math.min(PANEL_MIN_HEIGHT, maxHeight),
    maxHeight,
  };
}

/** Fits a rectangle into the window: size within limits, fully on screen. */
export function clampRect(rect: PanelRect, viewport: Viewport): PanelRect {
  const limits = sizeLimits(viewport);
  const width = clamp(rect.width, limits.minWidth, limits.maxWidth);
  const height = clamp(rect.height, limits.minHeight, limits.maxHeight);
  // Math.max(...) guards windows narrower than the card: pin it to the margin.
  const maxX = Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN);
  const maxY = Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN);
  return {
    x: clamp(rect.x, PANEL_MARGIN, maxX),
    y: clamp(rect.y, PANEL_MARGIN, maxY),
    width,
    height,
  };
}

/** Bottom-right corner — clear of the top-centre toolbar. */
export function defaultRect(viewport: Viewport): PanelRect {
  const size = clampRect({ x: 0, y: 0, width: PANEL_DEFAULT_WIDTH, height: PANEL_DEFAULT_HEIGHT }, viewport);
  return clampRect(
    {
      ...size,
      x: viewport.width - size.width - PANEL_DEFAULT_INSET,
      y: viewport.height - size.height - PANEL_DEFAULT_INSET,
    },
    viewport,
  );
}

/** The "Expand" size: as large as allowed, anchored bottom-right like the default. */
export function expandedRect(viewport: Viewport): PanelRect {
  const limits = sizeLimits(viewport);
  return clampRect(
    {
      width: limits.maxWidth,
      height: limits.maxHeight,
      x: viewport.width - limits.maxWidth - PANEL_DEFAULT_INSET,
      y: viewport.height - limits.maxHeight - PANEL_DEFAULT_INSET,
    },
    viewport,
  );
}

/** Dragging by the header: shift by the pointer's movement, stay on screen. */
export function moveRect(start: PanelRect, dx: number, dy: number, viewport: Viewport): PanelRect {
  return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, viewport);
}

/**
 * Resizing with the TOP-LEFT corner handle. The bottom-right corner stays put,
 * like the Council panel's handle — natural for a card that lives in the
 * bottom-right corner. dx/dy are the pointer's movement since the drag began.
 */
export function resizeFromTopLeft(start: PanelRect, dx: number, dy: number, viewport: Viewport): PanelRect {
  const limits = sizeLimits(viewport);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  // Dragging the corner LEFT/UP (negative dx/dy) makes the card bigger.
  let width = clamp(start.width - dx, limits.minWidth, limits.maxWidth);
  let height = clamp(start.height - dy, limits.minHeight, limits.maxHeight);
  // Can't grow past the window's left/top margin.
  width = Math.min(width, Math.max(limits.minWidth, right - PANEL_MARGIN));
  height = Math.min(height, Math.max(limits.minHeight, bottom - PANEL_MARGIN));
  return clampRect({ x: right - width, y: bottom - height, width, height }, viewport);
}

function intersects(rect: PanelRect, zone: AvoidZone): boolean {
  return rect.x < zone.right && rect.x + rect.width > zone.left && rect.y < zone.bottom && rect.y + rect.height > zone.top;
}

/**
 * Slides the card out of each zone it overlaps — LEFT or UP, whichever is the
 * shorter move that still fits on screen. If neither fits (tiny window), it
 * goes as far left as it can; some overlap is then unavoidable.
 * Returns the same object when nothing overlaps.
 */
export function avoidZones(rect: PanelRect, zones: AvoidZone[]): PanelRect {
  let current = rect;
  for (const zone of zones) {
    if (!intersects(current, zone)) continue;
    const leftX = zone.left - AVOID_GAP - current.width;
    const upY = zone.top - AVOID_GAP - current.height;
    const leftFits = leftX >= PANEL_MARGIN;
    const upFits = upY >= PANEL_MARGIN;
    const leftDistance = current.x - leftX;
    const upDistance = current.y - upY;

    if (leftFits && (!upFits || leftDistance <= upDistance)) {
      current = { ...current, x: leftX };
    } else if (upFits) {
      current = { ...current, y: upY };
    } else {
      current = { ...current, x: Math.max(PANEL_MARGIN, leftX) };
    }
  }
  return current;
}

/** The right-hand rail used by the Sim / Plans / Route / Generated panels (full height). */
export function rightRailZone(viewport: Viewport): AvoidZone {
  return { left: viewport.width - RIGHT_RAIL_RESERVED, top: 0, right: viewport.width, bottom: viewport.height };
}

/**
 * Where the Planning Council panel sits. These numbers mirror its own layout
 * (ChatPanel.tsx `panelLayoutStyle`: bottom 1.25rem, right 56 px + 30 px — or
 * 376 px + 30 px when the route panel is open — up to 620 × 780 px). Keep them
 * in sync if that layout changes.
 */
export function councilZone(viewport: Viewport, routePanelOpen: boolean): AvoidZone {
  const rightOffset = (routePanelOpen ? 376 : 56) + 30;
  const width = Math.min(620, viewport.width - (routePanelOpen ? 422 : 122));
  const height = Math.min(780, viewport.height - 88); // 5.5rem
  const bottom = viewport.height - 20; // 1.25rem
  return {
    left: viewport.width - rightOffset - width,
    right: viewport.width - rightOffset,
    top: bottom - height,
    bottom,
  };
}

// ── Saving the user's choice ─────────────────────────────────────────────────

/** v3: v2 only stored {x, y}; the card is now resizable, so size is saved too. */
export const PANEL_STORAGE_KEY = "t_aiChatPos_v3";

export interface SavedPanelState {
  rect: PanelRect;
  expanded: boolean;
}

export function serializePanelState(state: SavedPanelState): string {
  return JSON.stringify({ ...state.rect, expanded: state.expanded });
}

/** Reads what serializePanelState wrote; null if missing or invalid. */
export function parsePanelState(raw: string | null): SavedPanelState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const numbers = [parsed.x, parsed.y, parsed.width, parsed.height];
    if (!numbers.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    return {
      rect: {
        x: parsed.x as number,
        y: parsed.y as number,
        width: parsed.width as number,
        height: parsed.height as number,
      },
      expanded: parsed.expanded === true,
    };
  } catch {
    return null;
  }
}
