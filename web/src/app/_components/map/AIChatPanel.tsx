"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { useMapAssistantActions } from "./MapAssistantContext";
import { TransitAssistant } from "./TransitAssistant";
import { CloseIcon, CollapseIcon, ExpandIcon, NewChatIcon, ResizeGripIcon, SparkleIcon } from "./assistant/icons";
import {
  avoidZones,
  clampRect,
  councilZone,
  defaultRect,
  expandedRect,
  moveRect,
  PANEL_STORAGE_KEY,
  parsePanelState,
  resizeFromTopLeft,
  rightRailZone,
  serializePanelState,
  type AvoidZone,
  type PanelRect,
  type SavedPanelState,
  type Viewport,
} from "./assistant/panel-geometry";

interface Props {
  onClose: () => void;
  /** Text to pre-fill the message box (one-shot — TransitAssistant consumes it via onSeedConsumed). */
  seed?: string | null;
  onSeedConsumed?: () => void;
  /** A right-rail panel (Sim, Plans, Route, Generated) is open: slide left of it. */
  avoidRightRail?: boolean;
  /** The Planning Council panel is open in the bottom-right: slide up/left of it. */
  avoidBottomRight?: boolean;
}

/** Window size, measured after mount (the server has no window) and on every resize. */
function useViewportSize(): Viewport | null {
  const [size, setSize] = useState<Viewport | null>(null);
  useLayoutEffect(() => {
    function measure() {
      setSize({ width: window.innerWidth, height: window.innerHeight });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return size;
}

/** An in-progress drag (move) or resize, started by a pointer. */
interface Gesture {
  kind: "move" | "resize";
  pointerId: number;
  startX: number;
  startY: number;
  startRect: PanelRect;
  /** False until the pointer has travelled DRAG_THRESHOLD_PX — a click is not a drag. */
  moved: boolean;
}

/** Hand jitter during a click/double-click must not move (or un-expand) the card. */
const DRAG_THRESHOLD_PX = 3;

/**
 * The floating Ask AI card: draggable by its header (mouse, pen and touch),
 * resizable from its top-left corner, expandable, and it slides out of the
 * way of other panels. Its position and size are remembered (t_aiChatPos_v3).
 * The chat inside is <TransitAssistant/>; the conversation lives in
 * MapAssistantProvider, so closing the card doesn't stop or lose an answer.
 */
export function AIChatPanel({ onClose, seed, onSeedConsumed, avoidRightRail = false, avoidBottomRight = false }: Props) {
  // Only the stable actions: this shell must not re-render for every streamed word.
  const { newChat } = useMapAssistantActions();
  const viewport = useViewportSize();

  // The user's own choice of place and size (what gets saved). What is SHOWN
  // is derived from it below, so it can slide back when a side panel closes.
  const [saved, setSaved] = useState<SavedPanelState | null>(null);
  const [gestureKind, setGestureKind] = useState<Gesture["kind"] | null>(null);
  const gestureRef = useRef<Gesture | null>(null);

  // Read the saved place after mount (localStorage doesn't exist on the server).
  useLayoutEffect(() => {
    let restored: SavedPanelState | null = null;
    try {
      restored = parsePanelState(localStorage.getItem(PANEL_STORAGE_KEY));
    } catch {
      /* storage blocked */
    }
    setSaved(restored ?? { rect: defaultRect({ width: window.innerWidth, height: window.innerHeight }), expanded: false });
  }, []);

  // Save once a gesture has ended (not on every pointer move).
  useEffect(() => {
    if (!saved || gestureKind !== null) return;
    try {
      localStorage.setItem(PANEL_STORAGE_KEY, serializePanelState(saved));
    } catch {
      /* storage full or blocked — the card still works, it just won't remember */
    }
  }, [saved, gestureKind]);

  const shownRect = useMemo<PanelRect | null>(() => {
    if (!viewport || !saved) return null;
    const base = saved.expanded ? expandedRect(viewport) : clampRect(saved.rect, viewport);
    const zones: AvoidZone[] = [];
    if (avoidRightRail) zones.push(rightRailZone(viewport));
    // The council panel shifts left when the route panel (part of the right rail) is open.
    if (avoidBottomRight) zones.push(councilZone(viewport, avoidRightRail));
    return avoidZones(base, zones);
  }, [viewport, saved, avoidRightRail, avoidBottomRight]);

  // ── Pointer gestures ──
  // 📖 Learn: Pointer Events cover mouse, pen and touch with one API, and
  // setPointerCapture keeps sending moves to this element even when the
  // pointer leaves it — so fast drags don't "drop" the card.
  function beginGesture(kind: Gesture["kind"], event: PointerEvent<HTMLElement>) {
    if (!shownRect) return;
    if (event.pointerType === "mouse" && event.button !== 0) return; // primary button only
    // The header's buttons handle their own clicks.
    if (kind === "move" && (event.target as HTMLElement).closest("button")) return;
    event.preventDefault(); // no text selection while dragging
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      kind,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startRect: shownRect,
      moved: false,
    };
    setGestureKind(kind);
  }

  function continueGesture(event: PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (gesture?.pointerId !== event.pointerId || !viewport) return; // not our pointer (or no gesture)
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    if (!gesture.moved) {
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      gesture.moved = true;
    }
    const rect =
      gesture.kind === "move"
        ? moveRect(gesture.startRect, dx, dy, viewport)
        : resizeFromTopLeft(gesture.startRect, dx, dy, viewport);
    // Moving or resizing an expanded card turns it into a normal one at its current size.
    setSaved({ rect, expanded: false });
  }

  function endGesture(event: PointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;
    if (gesture?.pointerId !== event.pointerId) return; // not our pointer (or no gesture)
    gestureRef.current = null;
    setGestureKind(null); // triggers the save effect above
  }

  function toggleExpanded() {
    setSaved((previous) => (previous ? { ...previous, expanded: !previous.expanded } : previous));
  }

  const expanded = saved?.expanded ?? false;
  const style = shownRect
    ? {
        left: shownRect.x,
        top: shownRect.y,
        width: shownRect.width,
        height: shownRect.height,
        // Slide smoothly when avoiding panels / expanding, but follow the pointer exactly while dragging.
        transition:
          gestureKind === null ? "left 0.25s ease, top 0.25s ease, width 0.2s ease, height 0.2s ease" : "none",
      }
    : // First render, before the window was measured: invisible, so it never flashes in the wrong place.
      { left: 0, top: 0, visibility: "hidden" as const };

  return (
    <div
      role="dialog"
      aria-label="Ask AI"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          onClose();
        }
      }}
      className="pointer-events-auto fixed z-30 flex flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white text-stone-800 shadow-2xl dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
      style={style}
    >
      {/* Resize corner (top-left: the card usually lives in the bottom-right). Mouse/touch only — the Expand button is the keyboard way to get a bigger card. */}
      <div
        aria-hidden="true"
        title="Drag to resize"
        onPointerDown={(event) => beginGesture("resize", event)}
        onPointerMove={continueGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        className="group absolute left-0 top-0 z-10 flex h-4 w-4 cursor-nwse-resize touch-none items-center justify-center"
      >
        <ResizeGripIcon className="h-2.5 w-2.5 text-stone-400 opacity-0 transition-opacity group-hover:opacity-100" />
      </div>

      {/* Header = drag handle. touch-none stops touch-drags from scrolling the page. */}
      <header
        onPointerDown={(event) => beginGesture("move", event)}
        onPointerMove={continueGesture}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
        onDoubleClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) toggleExpanded();
        }}
        className={`flex shrink-0 touch-none select-none items-center gap-2 border-b border-stone-100 py-2 pl-4 pr-2 dark:border-stone-800 ${
          gestureKind === "move" ? "cursor-grabbing" : "cursor-grab"
        }`}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-teal-50 text-teal-600 dark:bg-teal-500/15 dark:text-teal-300">
          <SparkleIcon className="h-4 w-4" />
        </span>
        <h2 className="text-sm font-semibold text-stone-800 dark:text-stone-100">Ask AI</h2>
        <span className="rounded-full bg-teal-50 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-teal-700 ring-1 ring-inset ring-teal-200 dark:bg-teal-500/15 dark:text-teal-300 dark:ring-teal-800">
          beta
        </span>
        <div className="ml-auto flex items-center gap-0.5">
          <HeaderButton label="New chat" onClick={newChat}>
            <NewChatIcon className="h-4 w-4" />
          </HeaderButton>
          <HeaderButton label={expanded ? "Restore size" : "Expand"} onClick={toggleExpanded}>
            {expanded ? <CollapseIcon className="h-4 w-4" /> : <ExpandIcon className="h-4 w-4" />}
          </HeaderButton>
          <HeaderButton label="Close" onClick={onClose}>
            <CloseIcon className="h-4 w-4" />
          </HeaderButton>
        </div>
      </header>

      {/* Mounted once the card has its real position, so focusing the message box works (hidden elements can't take focus). */}
      {shownRect && <TransitAssistant seed={seed} onSeedConsumed={onSeedConsumed} variant="panel" />}
    </div>
  );
}

function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-8 w-8 items-center justify-center rounded-lg text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-stone-400 dark:hover:bg-stone-800 dark:hover:text-stone-100"
    >
      {children}
    </button>
  );
}
