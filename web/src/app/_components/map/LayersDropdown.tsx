"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// 📖 Learn: a "controlled" component — the parent owns the state (which
// overlays are on, which are pinned) and passes it in. The dropdown is a
// pure view that emits intent (toggle / pin) and never holds overlay state
// itself. This keeps localStorage persistence in the parent next to the
// other `t_*` settings instead of scattered across components.
export interface OverlaySpec {
  id: string;
  label: string;
  /** Sub-label shown only inside the dropdown row. Optional. */
  sub?: string;
  on: boolean;
  loading?: boolean;
  onToggle: () => void;
  /** Indicator dot color when active (any CSS color). */
  color: string;
  /**
   * Optional glyph shown on the pinned toolbar chip in place of the colour
   * dot. Tinted by `color` when on / grey when off (SVG must use
   * currentColor). Falls back to the colour dot when omitted.
   */
  icon?: ReactNode;
  /**
   * Optional inline-expandable controls (e.g. sliders, pickers) shown ONLY
   * when the overlay is on. Used for Isochrone, which is meaningless without
   * an origin/duration. Other overlays keep their config in ExperimentalPanel.
   */
  details?: ReactNode;
  /** If true, this overlay cannot be pinned to the toolbar (e.g. it has details). */
  noPin?: boolean;
}

/**
 * Action rows are the misfit citizens of the Layers dropdown: things that
 * are not on/off toggles (Custom overlay = file picker, Measure distance =
 * click-mode tool). They render below all overlays under a divider.
 */
export interface ActionRow {
  id: string;
  label: string;
  /** Optional state — e.g. measure mode is "active" while picking. */
  active?: boolean;
  /** Loaded-file name shown next to the label, if any. */
  badge?: string;
  /** Right-aligned icon (e.g. an X to clear, or an upload arrow). */
  icon?: ReactNode;
  onClick: () => void;
}

interface Props {
  overlays: OverlaySpec[];
  pinned: Set<string>;
  onTogglePin: (id: string) => void;
  /** Optional non-overlay rows (e.g. Measure, Custom overlay) shown under a divider. */
  actions?: ActionRow[];
}

export function LayersDropdown({ overlays, pinned, onTogglePin, actions = [] }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape. Standard popover hygiene.
  useEffect(() => {
    if (!open) return;
    function onMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pinnedOverlays = overlays.filter((o) => pinned.has(o.id));
  const activeCount = overlays.filter((o) => o.on).length;

  return (
    // Layers dropdown. Pinned overlays no longer sit inline in the toolbar —
    // they hang as a vertical stack BELOW this button (see below), so the top
    // toolbar stays uncluttered.
    <div ref={containerRef} className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          className={`pointer-events-auto flex h-13 items-center gap-2.5 rounded-xl border border-[#D7D7D7] bg-white px-5 text-base font-normal shadow-sm transition-all ${
            open || activeCount > 0 ? "text-stone-700" : "text-stone-400"
          }`}
        >
          {/* Stacked-sheets icon — signals "layers" */}
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4.5 w-4.5">
            <path d="M10 2.5 L17.5 6.5 L10 10.5 L2.5 6.5 Z" />
            <path d="M2.5 10 L10 14 L17.5 10" />
            <path d="M2.5 13.5 L10 17.5 L17.5 13.5" />
          </svg>
          Layers
          {activeCount > 0 && (
            // key={activeCount} remounts the badge on each change so the
            // pop-in animation re-fires (not just on first appearance).
            <span
              key={activeCount}
              className="animate-badge-pop ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-stone-100 px-1.5 text-xs font-medium text-stone-600"
            >
              {activeCount}
            </span>
          )}
          {/* chevron */}
          <svg viewBox="0 0 20 20" fill="currentColor" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`}>
            <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.06l3.71-3.83a.75.75 0 1 1 1.08 1.04l-4.25 4.39a.75.75 0 0 1-1.08 0L5.21 8.27a.75.75 0 0 1 .02-1.06Z" clipRule="evenodd" />
          </svg>
        </button>

        {/* Pinned quick-toggles hang below the Layers button as a row of fixed
            36×36 SQUARE icon buttons (left-aligned to the button). The icons
            never move — the name appears as a floating tooltip on hover.
            Keeping the squares stationary means moving between adjacent chips
            is a short, stable motion (no layout reflow shoving the next chip
            away). The tooltip is pointer-events-none so it never captures the
            cursor or blocks the chip behind it. Hidden while the dropdown is
            open — the panel lists them anyway. */}
        {!open && pinnedOverlays.length > 0 && (
          <div className="pointer-events-none absolute top-full left-0 mt-1.5 flex items-center justify-start gap-1.5">
            {pinnedOverlays.map((o) => (
              <button
                key={o.id}
                onClick={o.onToggle}
                title={o.label}
                className={`group pointer-events-auto relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#D7D7D7] bg-white shadow-sm transition-colors ${
                  o.on ? "text-stone-700" : "text-stone-400"
                }`}
              >
                {o.loading ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-stone-300 border-t-stone-500" />
                ) : o.icon ? (
                  // Tint the glyph via `color` — the SVG paints with currentColor.
                  <span className="flex h-5 w-5 items-center justify-center" style={{ color: o.on ? o.color : "#9ca3af" }}>
                    {o.icon}
                  </span>
                ) : (
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: o.on ? o.color : "#d1d5db" }} />
                )}
                {/* Floating name tooltip: overlay to the right of the icon. It
                    slides in + fades (transform/opacity only — no layout shift)
                    and sits above neighbouring chips (z-20). */}
                <span className="pointer-events-none absolute left-full top-1/2 z-20 ml-1.5 -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-lg border border-[#D7D7D7] bg-white px-2.5 py-1 text-sm text-stone-700 opacity-0 shadow-sm transition duration-200 ease-out group-hover:translate-x-0 group-hover:opacity-100">
                  {o.label}
                </span>
              </button>
            ))}
          </div>
        )}

        {open && (
          // Anchored LEFT, not right: the top toolbar is centre-justified, so
          // this button sits left-of-centre. Growing the 18rem panel leftward
          // (right-0) ran it off the left edge of the viewport. Growing it
          // rightward keeps it over open map, and lines it up with the pinned
          // chip stack above, which is also left-0.
          // 📖 Learn: Tailwind `left-0`/`right-0` on an absolute child pin that
          // EDGE of the child to the same edge of the `relative` parent; the
          // box then extends away from it. They are anchors, not alignment.
          <div className="pointer-events-auto absolute top-full left-0 mt-2 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg">
            <div className="border-b border-stone-100 px-3.5 py-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-stone-400">Map overlays</p>
            </div>
            <div className="max-h-112 overflow-y-auto py-1">
              {overlays.map((o) => {
                const isPinned = pinned.has(o.id);
                return (
                  <div key={o.id}>
                    <div className="group flex items-center gap-3 px-3.5 py-2 hover:bg-stone-50">
                      <button
                        onClick={o.onToggle}
                        className="flex flex-1 items-center gap-2.5 text-left"
                      >
                        {o.loading ? (
                          <span className="h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-stone-300 border-t-stone-500" />
                        ) : (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-stone-200"
                            style={{ background: o.on ? o.color : "transparent" }}
                          />
                        )}
                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-sm ${o.on ? "font-medium text-stone-800" : "text-stone-600"}`}>
                            {o.label}
                          </p>
                          {o.sub && <p className="truncate text-[11px] text-stone-400">{o.sub}</p>}
                        </div>
                      </button>
                      {!o.noPin && (
                        <button
                          onClick={() => onTogglePin(o.id)}
                          title={isPinned ? "Unpin from toolbar" : "Pin to toolbar"}
                          aria-label={isPinned ? "Unpin from toolbar" : "Pin to toolbar"}
                          className={`shrink-0 rounded-md p-1 transition-colors ${
                            isPinned
                              ? "text-indigo-600 hover:bg-indigo-50"
                              : "text-stone-300 opacity-0 group-hover:opacity-100 hover:text-stone-600"
                          }`}
                        >
                          {/* Pin icon — filled when pinned, outline otherwise */}
                          <svg viewBox="0 0 20 20" fill={isPinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
                            <path d="M9.5 2 L13 2 L12 6 L15 9 L11 10 L11 17 L9.5 17 L9.5 10 L6 9 L8.5 6 Z" />
                          </svg>
                        </button>
                      )}
                    </div>
                    {/* Inline details: shown only when overlay is ON and has details. */}
                    {o.on && o.details && (
                      <div className="border-t border-stone-100 bg-stone-50/60 px-3.5 py-2.5">
                        {o.details}
                      </div>
                    )}
                  </div>
                );
              })}
              {actions.length > 0 && (
                <>
                  <div className="my-1 border-t border-stone-100" />
                  <div className="px-3.5 pt-1.5 pb-0.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-stone-400">Tools</p>
                  </div>
                  {actions.map((a) => (
                    <button
                      key={a.id}
                      onClick={a.onClick}
                      className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left hover:bg-stone-50 ${
                        a.active ? "bg-amber-50/60" : ""
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <p className={`truncate text-sm ${a.active ? "font-medium text-amber-700" : "text-stone-600"}`}>
                          {a.label}
                          {a.badge && (
                            <span className="ml-1.5 text-[11px] font-normal text-stone-400">· {a.badge}</span>
                          )}
                        </p>
                      </span>
                      {a.icon && <span className="shrink-0 text-stone-400">{a.icon}</span>}
                    </button>
                  ))}
                </>
              )}
            </div>
            <div className="border-t border-stone-100 bg-stone-50 px-3.5 py-2">
              <p className="text-[10px] text-stone-400">
                Hover a row and click the pin to add it to the toolbar.
              </p>
            </div>
          </div>
        )}
      </div>
  );
}
