"use client";

// 📖 Learn: This is a "scaffold" — the full structure and layout are defined,
// but props marked TODO need to be wired up from TransitMap.tsx before each
// section is fully functional. Scaffold lets us nail the UX shape first.

import { useState } from "react";
import type { Route } from "~/app/map/transit-data";

// ── Which bottom sheet is open ────────────────────────────────────────────────
type Sheet = "lines" | "overlays" | "tools" | "settings" | null;

// ── Props from TransitMap ─────────────────────────────────────────────────────
// Only the pieces that each sheet actually needs. Extend as each section is wired up.
interface MobileNavProps {
  // Lines sheet
  routes: Route[];
  onNewLine: () => void;

  // Overlays sheet
  showHeatmap: boolean;
  onToggleHeatmap: () => void;
  showTraffic: boolean;
  onToggleTraffic: () => void;

  // Settings sheet
  darkMode: boolean;
  onToggleDarkMode: () => void;
  onResetProject: () => void;

  // Draw mode (shown in top strip on mobile)
  drawMode: string;
  onSetDrawMode: (mode: "normal" | "addStation" | "deleteStation" | "moveStation" | "addPortal") => void;

  // Game Mode
  onOpenGameMode: () => void;

  // Ask AI — opens the same chat as the desktop toolbar's "Ask AI" button
  onOpenAssistant?: () => void;
}

// ── Tab bar item config ───────────────────────────────────────────────────────
const TABS: { id: Exclude<Sheet, null> | "new"; label: string; icon: React.ReactNode }[] = [
  {
    id: "lines",
    label: "Lines",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        <path d="M3 5h14M3 10h14M3 15h14" />
      </svg>
    ),
  },
  {
    id: "overlays",
    label: "Overlays",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="7" /><circle cx="10" cy="10" r="3" />
      </svg>
    ),
  },
  {
    // Centre "+" button — doesn't open a sheet, directly triggers New Line
    id: "new",
    label: "New Line",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M10 4v12M4 10h12" />
      </svg>
    ),
  },
  {
    id: "tools",
    label: "Tools",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6h12M4 10h8M4 14h5" />
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10" cy="10" r="2.5" />
        <path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.22 4.22l1.42 1.42M14.36 14.36l1.42 1.42M4.22 15.78l1.42-1.42M14.36 5.64l1.42-1.42" />
      </svg>
    ),
  },
];

// ── Bottom sheet wrapper ──────────────────────────────────────────────────────
function BottomSheet({ open, onClose, title, children }: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    // 📖 Learn: Two layers — the dark overlay behind, and the white sheet on top.
    // The sheet slides up from the bottom using translate-y. We use a fixed
    // max-height so it never covers the full screen (map stays visible at top).
    <>
      {/* Backdrop — tapping it closes the sheet */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
      />
      <div className="fixed bottom-16 left-0 right-0 z-50 flex max-h-[70vh] flex-col rounded-t-2xl bg-white shadow-2xl">
        {/* Drag handle */}
        <div className="flex justify-center pt-3 pb-1 shrink-0">
          <div className="h-1 w-10 rounded-full bg-stone-200" />
        </div>
        {/* Sheet header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-stone-100 shrink-0">
          <p className="text-base font-semibold text-stone-800">{title}</p>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700">
            <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 3l10 10M13 3L3 13" />
            </svg>
          </button>
        </div>
        {/* Scrollable sheet content */}
        <div className="overflow-y-auto flex-1 px-5 py-4">
          {children}
        </div>
      </div>
    </>
  );
}

// ── Toggle row (used in Overlays and Settings sheets) ────────────────────────
function ToggleRow({ label, on, onToggle }: { label: string; on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex w-full items-center justify-between py-3 border-b border-stone-100 last:border-0"
    >
      <span className="text-sm text-stone-700">{label}</span>
      {/* 📖 Learn: The toggle pill — a rounded-full div with an inner circle
          that translates right/left based on the `on` state */}
      <span className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${on ? "bg-stone-800" : "bg-stone-200"}`}>
        <span className={`absolute top-1 h-3 w-3 rounded-full bg-white shadow transition-transform ${on ? "translate-x-5" : "translate-x-1"}`} />
      </span>
    </button>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export function MobileNav({
  routes,
  onNewLine,
  showHeatmap,
  onToggleHeatmap,
  showTraffic,
  onToggleTraffic,
  darkMode,
  onToggleDarkMode,
  onResetProject,
  drawMode,
  onSetDrawMode,
  onOpenGameMode,
  onOpenAssistant,
}: MobileNavProps) {
  const [sheet, setSheet] = useState<Sheet>(null);

  function toggleSheet(id: Sheet) {
    setSheet((prev) => (prev === id ? null : id));
  }

  return (
    <>
      {/* ── Draw mode strip — sits just above the bottom tab bar ─────────── */}
      {/* Shows the 4 drawing tools as a compact icon row so the map is still usable */}
      <div className="fixed bottom-16 left-0 right-0 z-30 flex justify-center pointer-events-none">
        <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-stone-200 bg-white px-2 py-1.5 shadow-sm mb-1">
          {(
            [
              { mode: "normal",         label: "Select",  icon: "↖" },
              { mode: "addStation",     label: "Add stop",icon: "+" },
              { mode: "deleteStation",  label: "Delete",  icon: "✕" },
              { mode: "moveStation",    label: "Move",    icon: "⤢" },
            ] as const
          ).map(({ mode, label, icon }) => (
            <button
              key={mode}
              onClick={() => onSetDrawMode(mode)}
              title={label}
              className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm transition-all ${
                drawMode === mode
                  ? "bg-stone-900 text-white"
                  : "text-stone-400 hover:bg-stone-50 hover:text-stone-700"
              }`}
            >
              {icon}
            </button>
          ))}
        </div>
      </div>

      {/* ── Bottom tab bar ────────────────────────────────────────────────── */}
      {/* Fixed to the bottom edge, sits above iOS home indicator via pb-safe */}
      <div className="fixed bottom-0 left-0 right-0 z-40 flex items-stretch border-t border-stone-200 bg-white pb-safe">
        {TABS.map(({ id, label, icon }) => {
          const isNew = id === "new";
          const isActive = !isNew && sheet === id;

          return (
            <button
              key={id}
              onClick={() => {
                if (isNew) {
                  setSheet(null);
                  onNewLine();
                } else {
                  toggleSheet(id as Sheet);
                }
              }}
              className={`flex flex-1 flex-col items-center justify-center gap-0.5 py-2 transition-colors ${
                isNew
                  // Centre "+" button gets a filled circle treatment
                  ? "text-white"
                  : isActive
                  ? "text-stone-900"
                  : "text-stone-400"
              }`}
            >
              {isNew ? (
                // The "New Line" centre button is a filled circle
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-900 text-white shadow">
                  {icon}
                </span>
              ) : (
                <>
                  {icon}
                  <span className="text-[10px] font-medium leading-none">{label}</span>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Lines sheet ───────────────────────────────────────────────────── */}
      <BottomSheet open={sheet === "lines"} onClose={() => setSheet(null)} title="Lines">
        {routes.length === 0 ? (
          <p className="text-sm text-stone-400">No lines yet. Tap + to add one.</p>
        ) : (
          <div className="space-y-1">
            {routes.map((route) => (
              <div key={route.id} className="flex items-center gap-3 py-2 border-b border-stone-50 last:border-0">
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{ background: route.color }}
                />
                <span className="flex-1 text-sm text-stone-700 truncate">{route.name}</span>
                {/* TODO: tap row to select route and open RoutePanel */}
              </div>
            ))}
          </div>
        )}
      </BottomSheet>

      {/* ── Overlays sheet ────────────────────────────────────────────────── */}
      <BottomSheet open={sheet === "overlays"} onClose={() => setSheet(null)} title="Map Overlays">
        <ToggleRow label="Population Density" on={showHeatmap} onToggle={onToggleHeatmap} />
        <ToggleRow label="Traffic" on={showTraffic} onToggle={onToggleTraffic} />
        {/* TODO: add GO Transit, coverage zones, service heatmap toggles */}
      </BottomSheet>

      {/* ── Tools sheet ───────────────────────────────────────────────────── */}
      <BottomSheet open={sheet === "tools"} onClose={() => setSheet(null)} title="Tools">
        {/* TODO: render a simplified flat list of ExperimentalPanel features
            instead of the desktop tile grid (grid is too small on mobile) */}
        <div className="space-y-1">
          {(
            [
              { label: "Network Stats",     desc: "Routes, stops, headways" },
              { label: "Route Score",       desc: "Grade selected route" },
              { label: "Travel Time Map",   desc: "Walkable isochrone from stop" },
              { label: "Cost Estimator",    desc: "Capital & operating costs" },
              { label: "Ridership Forecast",desc: "Gravity model projections" },
              // Wired: closes this sheet first so the chat isn't hidden behind it.
              { label: "AI Assistant",      desc: "Chat with your network", onClick: onOpenAssistant },
            ] as { label: string; desc: string; onClick?: () => void }[]
          ).map(({ label, desc, onClick }) => (
            <button
              key={label}
              // TODO: wire the remaining rows to open the correct ExperimentalPanel tab
              onClick={onClick ? () => { setSheet(null); onClick(); } : undefined}
              className="flex w-full flex-col items-start py-3 border-b border-stone-100 last:border-0 text-left"
            >
              <span className="text-sm font-medium text-stone-800">{label}</span>
              <span className="text-xs text-stone-400">{desc}</span>
            </button>
          ))}

          {/* Game Mode — full-width button at the bottom of the tools list */}
          <button
            onClick={() => { setSheet(null); onOpenGameMode(); }}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-indigo-200 bg-indigo-50 py-3 text-sm font-semibold text-indigo-700"
          >
            🎮 Game Mode
          </button>
        </div>
      </BottomSheet>

      {/* ── Settings sheet ────────────────────────────────────────────────── */}
      <BottomSheet open={sheet === "settings"} onClose={() => setSheet(null)} title="Settings">
        <ToggleRow label="Dark mode" on={darkMode} onToggle={onToggleDarkMode} />
        {/* TODO: add High contrast, Imperial units, Tools panel, GO Transit toggles */}

        <button
          onClick={() => { setSheet(null); onResetProject(); }}
          className="mt-4 flex w-full items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600"
        >
          <svg viewBox="0 0 16 16" fill="none" className="h-4 w-4 shrink-0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 4h12M5 4V2h6v2M6 7v5M10 7v5M3 4l1 9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-9" />
          </svg>
          Reset project
        </button>
      </BottomSheet>
    </>
  );
}
