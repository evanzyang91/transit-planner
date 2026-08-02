"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { Route } from "~/app/map/transit-data";
import type { PlanSession, PlanSessionSummary } from "~/lib/plans";

function InlineSaveForm({ onConfirm, onCancel }: { onConfirm: (name: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function handleConfirm() {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onConfirm(trimmed);
    } catch {
      setError("Failed to save. Try again.");
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-stone-500 dark:text-stone-400">Name this plan</p>
      <input
        ref={inputRef}
        className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none placeholder-stone-400 transition-colors focus:border-stone-400 dark:border-white/10 dark:bg-[#28282a] dark:text-white dark:placeholder-stone-500 dark:focus:border-stone-500"
        placeholder="Plan name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleConfirm();
          if (e.key === "Escape") onCancel();
        }}
      />
      {error && <p className="text-xs text-red-500">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={onCancel}
          className="flex-1 rounded-lg border border-stone-200 py-2 text-sm text-stone-600 transition-colors hover:bg-stone-50 dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/5"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleConfirm()}
          disabled={!name.trim() || saving}
          className="flex-1 rounded-lg bg-stone-900 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:opacity-40 dark:bg-white dark:text-stone-900 dark:hover:bg-stone-100"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

type PlansPanelProps = {
  open: boolean;
  routes: Route[];
  hiddenRoutes: Set<string>;
  /** Dismissed transfers, saved and restored alongside the routes. */
  transferExclusions: Set<string>;
  currentPlanId: string | null;
  planIsDirty: boolean;
  authUser: { sub: string; name?: string; email?: string } | null | undefined;
  authLoading: boolean;
  onClose: () => void;
  onPlanLoaded: (routes: Route[], hiddenRoutes: Set<string>, planId: string, transferExclusions: Set<string>) => void;
  onCurrentPlanIdChange: (id: string | null) => void;
  onMarkSaved: (savedRoutes: Route[]) => void;
  onNewPlan: () => void;
  darkMode: boolean;
};

export function PlansPanel({
  open,
  routes,
  hiddenRoutes,
  transferExclusions,
  currentPlanId,
  planIsDirty,
  authUser,
  authLoading,
  onClose,
  onPlanLoaded,
  onCurrentPlanIdChange,
  onMarkSaved,
  onNewPlan,
}: PlansPanelProps) {
  const [plans, setPlans] = useState<PlanSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);

  const fetchPlans = useCallback(async () => {
    if (!authUser) return;
    setLoading(true);
    try {
      const res = await fetch("/api/sessions");
      if (res.ok) {
        const data = (await res.json()) as PlanSessionSummary[];
        setPlans(data);
      }
    } finally {
      setLoading(false);
    }
  }, [authUser]);

  useEffect(() => {
    if (open && authUser) {
      void fetchPlans();
    }
  }, [open, authUser, fetchPlans]);

  async function handleLoad(planId: string) {
    setActionLoading(planId);
    try {
      const res = await fetch(`/api/sessions/${planId}`);
      if (!res.ok) return;
      const plan = (await res.json()) as PlanSession;
      onPlanLoaded(
        plan.routes,
        new Set(plan.hiddenRoutes),
        plan.id,
        new Set(plan.transferExclusions ?? []),
      );
    } finally {
      setActionLoading(null);
    }
  }

  async function handleSaveInPlace() {
    if (!currentPlanId) {
      setShowSaveModal(true);
      return;
    }
    setActionLoading("saving");
    try {
      const res = await fetch(`/api/sessions/${currentPlanId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routes,
          hiddenRoutes: [...hiddenRoutes],
          transferExclusions: [...transferExclusions],
        }),
      });
      if (res.ok) {
        onMarkSaved(routes);
        await fetchPlans();
      }
    } finally {
      setActionLoading(null);
    }
  }

  async function handleConfirmSave(name: string) {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        routes,
        hiddenRoutes: [...hiddenRoutes],
        transferExclusions: [...transferExclusions],
      }),
    });
    if (!res.ok) throw new Error("Save failed");
    const created = (await res.json()) as PlanSession;
    onCurrentPlanIdChange(created.id);
    onMarkSaved(routes);
    await fetchPlans();
    setShowSaveModal(false);
  }

  async function handleRenameCommit(planId: string) {
    const trimmed = editingName.trim();
    if (!trimmed) { setEditingId(null); return; }
    setActionLoading(planId);
    try {
      const res = await fetch(`/api/sessions/${planId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (res.ok) {
        await fetchPlans();
      }
    } finally {
      setEditingId(null);
      setActionLoading(null);
    }
  }

  async function handleDelete(planId: string) {
    setActionLoading(planId);
    try {
      const res = await fetch(`/api/sessions/${planId}`, { method: "DELETE" });
      if (res.ok) {
        if (planId === currentPlanId) onCurrentPlanIdChange(null);
        setConfirmDeleteId(null);
        await fetchPlans();
      }
    } finally {
      setActionLoading(null);
    }
  }

  function handleNewPlan() {
    if (planIsDirty && !window.confirm("You have unsaved changes. Start a new blank plan anyway?")) return;
    onNewPlan();
  }

  const isSaving = actionLoading === "saving";
  const currentPlanName = plans.find((p) => p.id === currentPlanId)?.name;

  // Footer save button label
  const saveLabel = currentPlanId
    ? currentPlanName ? `Update "${currentPlanName}"` : "Save changes"
    : "Save new plan";

  return (
    <>
      {/* pointer-events-auto lives here, on the panel itself — same as
          RoutePanel/SimulationPanel/GeneratedRoutePanel. Relying on the parent
          wrapper to enable hits is what made this panel click-through once. */}
      <div className="pointer-events-auto flex h-full w-72 flex-col rounded-xl border border-[#D7D7D7] bg-white shadow-sm dark:border-white/10 dark:bg-[#1c1c1e]">
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-b border-stone-100 px-4 pb-3 pt-4 dark:border-white/5">
          <div className="flex items-start gap-2">
            <svg viewBox="0 0 16 16" fill="none" className="mt-0.5 h-4 w-4 shrink-0 text-stone-500 dark:text-stone-400" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 2h10a1 1 0 0 1 1 1v10l-3-2-2 2-2-2-3 2V3a1 1 0 0 1 1-1z"/>
            </svg>
            <div>
              <span className="text-sm font-semibold text-stone-800 dark:text-stone-100">My Plans</span>
              <p className="mt-0.5 text-xs text-stone-400 dark:text-stone-500">
                {currentPlanId
                  ? currentPlanName
                    ? <>Editing <span className="font-medium text-stone-600 dark:text-stone-300">{currentPlanName}</span>{planIsDirty ? " · unsaved" : ""}</>
                    : "Editing saved plan"
                  : planIsDirty
                    ? <span className="text-amber-500">Unsaved plan</span>
                    : "No plan open"
                }
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded-md text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-white/10 dark:hover:text-stone-300"
          >
            <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M3 3l10 10M13 3L3 13"/>
            </svg>
          </button>
        </div>

        {/* Not signed in */}
        {!authLoading && !authUser && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
            <svg viewBox="0 0 24 24" fill="none" className="h-10 w-10 text-stone-300 dark:text-stone-600" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
              <circle cx="12" cy="7" r="4"/>
            </svg>
            <p className="text-sm text-stone-500 dark:text-stone-400">Sign in to save and load your plans across sessions.</p>
            <a
              href="/auth/login"
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800 dark:bg-white dark:text-stone-900 dark:hover:bg-stone-100"
            >
              Sign in
            </a>
          </div>
        )}

        {/* Auth loading */}
        {authLoading && (
          <div className="flex flex-1 items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-stone-200 border-t-stone-500" />
          </div>
        )}

        {/* Plans list */}
        {!authLoading && authUser && (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-2">
              {loading ? (
                <div className="flex flex-col gap-2 py-2">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="h-10 animate-pulse rounded-lg bg-stone-100 dark:bg-white/5" />
                  ))}
                </div>
              ) : plans.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
                  <svg viewBox="0 0 24 24" fill="none" className="mb-3 h-8 w-8 text-stone-300 dark:text-stone-600" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
                  </svg>
                  <p className="text-sm text-stone-400 dark:text-stone-500">No saved plans yet.</p>
                  <p className="mt-1 text-xs text-stone-400 dark:text-stone-600">Save your current plan to get started.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-0.5 py-1">
                  {plans.map((plan) => {
                    const isActive = plan.id === currentPlanId;
                    const isEditing = editingId === plan.id;
                    const isConfirmingDelete = confirmDeleteId === plan.id;
                    const isActing = actionLoading === plan.id;

                    return (
                      <div key={plan.id}>
                        <div
                          className={`group flex items-center gap-2 rounded-lg px-2 py-2 transition-colors ${
                            isActive
                              ? "bg-indigo-50 dark:bg-indigo-500/10"
                              : "hover:bg-stone-50 dark:hover:bg-white/5"
                          }`}
                        >
                          {/* Status dot */}
                          <span
                            className={`h-2 w-2 shrink-0 rounded-full transition-colors ${
                              isActive
                                ? planIsDirty
                                  ? "bg-amber-400"
                                  : "bg-indigo-500"
                                : "bg-stone-200 dark:bg-stone-600"
                            }`}
                          />

                          {/* Name / edit input */}
                          <div className="min-w-0 flex-1">
                            {isEditing ? (
                              <input
                                autoFocus
                                className="w-full rounded border border-stone-200 bg-white px-1.5 py-0.5 text-sm text-stone-800 outline-none focus:border-indigo-400 dark:border-white/10 dark:bg-[#28282a] dark:text-white"
                                value={editingName}
                                onChange={(e) => setEditingName(e.target.value)}
                                onBlur={() => void handleRenameCommit(plan.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") void handleRenameCommit(plan.id);
                                  if (e.key === "Escape") setEditingId(null);
                                }}
                              />
                            ) : (
                              <div>
                                <p className="truncate text-sm font-medium text-stone-700 dark:text-stone-200" title={plan.name}>
                                  {plan.name}
                                </p>
                                <p className="text-xs text-stone-400 dark:text-stone-500">
                                  {plan.routeCount} line{plan.routeCount !== 1 ? "s" : ""}
                                  {isActive && planIsDirty && (
                                    <span className="ml-1.5 text-amber-500">· unsaved</span>
                                  )}
                                </p>
                              </div>
                            )}
                          </div>

                          {/* Actions */}
                          {!isEditing && !isActing && (
                            <div className="flex shrink-0 items-center gap-0.5">
                              {/* Open button — always visible for inactive plans */}
                              {!isActive && (
                                <button
                                  onClick={() => void handleLoad(plan.id)}
                                  className="rounded px-2 py-0.5 text-xs font-medium text-indigo-600 transition-colors hover:bg-indigo-50 dark:text-indigo-400 dark:hover:bg-indigo-500/10"
                                >
                                  Open
                                </button>
                              )}
                              <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                                <button
                                  onClick={() => { setEditingId(plan.id); setEditingName(plan.name); }}
                                  className="flex h-6 w-6 items-center justify-center rounded text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-white/10 dark:hover:text-stone-300"
                                  title="Rename"
                                >
                                  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M11 2l3 3-8 8H3v-3l8-8z"/>
                                  </svg>
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteId(plan.id)}
                                  className="flex h-6 w-6 items-center justify-center rounded text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                                  title="Delete"
                                >
                                  <svg viewBox="0 0 16 16" fill="none" className="h-3 w-3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M2 4h12M6 4V2h4v2M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4"/>
                                  </svg>
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Loading spinner */}
                          {isActing && (
                            <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-stone-200 border-t-stone-500" />
                          )}
                        </div>

                        {/* Delete confirmation */}
                        {isConfirmingDelete && (
                          <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg bg-red-50 px-3 py-2 dark:bg-red-500/10">
                            <p className="flex-1 text-xs text-red-600 dark:text-red-400">Delete "{plan.name}"?</p>
                            <button
                              onClick={() => void handleDelete(plan.id)}
                              className="rounded px-2 py-0.5 text-xs font-medium text-red-600 transition-colors hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-500/20"
                            >
                              Delete
                            </button>
                            <button
                              onClick={() => setConfirmDeleteId(null)}
                              className="rounded px-2 py-0.5 text-xs text-stone-500 transition-colors hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-white/10"
                            >
                              Cancel
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="shrink-0 border-t border-stone-100 px-4 py-3 dark:border-white/5">
              {showSaveModal ? (
                <InlineSaveForm
                  onConfirm={handleConfirmSave}
                  onCancel={() => setShowSaveModal(false)}
                />
              ) : (
                <div className="flex gap-2">
                  <button
                    onClick={() => void handleSaveInPlace()}
                    disabled={isSaving || (!planIsDirty && !!currentPlanId)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-all disabled:opacity-40 ${
                      planIsDirty && currentPlanId
                        ? "bg-indigo-600 text-white hover:bg-indigo-700 dark:bg-indigo-500 dark:hover:bg-indigo-400"
                        : "bg-stone-900 text-white hover:bg-stone-800 dark:bg-white dark:text-stone-900 dark:hover:bg-stone-100"
                    }`}
                    title={saveLabel}
                  >
                    {isSaving ? (
                      <>
                        <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                        Saving…
                      </>
                    ) : (
                      <>
                        <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5 shrink-0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M13 11v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-2M8 2v8M5 7l3 3 3-3"/>
                        </svg>
                        <span className="truncate">{saveLabel}</span>
                      </>
                    )}
                  </button>
                  <button
                    onClick={handleNewPlan}
                    className="flex items-center gap-1 rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-600 transition-colors hover:bg-stone-50 dark:border-white/10 dark:text-stone-300 dark:hover:bg-white/5"
                    title="New blank plan"
                  >
                    <svg viewBox="0 0 16 16" fill="none" className="h-3.5 w-3.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M8 3v10M3 8h10"/>
                    </svg>
                    New
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
