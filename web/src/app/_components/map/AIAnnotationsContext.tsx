"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { colorFromArgs, labelFromTool } from "~/lib/ai-map-tools-client";

export type AIAnnotationKind = "highlight" | "corridor" | "pin" | "flyTo";

export interface AIAnnotation {
  id: string;
  kind: AIAnnotationKind;
  args: Record<string, unknown>;
  turnId: string;
  /** Short label for the chip strip in chat. */
  label: string;
  color?: string;
}

// 📖 Learn: localStorage only stores strings, so we wrap the array in an
// envelope with a timestamp. On load we drop anything older than the TTL —
// stale findings from a past session are more confusing than helpful.
const STORAGE_KEY = "t_aiAnnotations";
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

type StoredEnvelope = {
  savedAt: number;
  annotations: AIAnnotation[];
};

function loadFromStorage(): AIAnnotation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredEnvelope;
    if (!parsed || !Array.isArray(parsed.annotations)) return [];
    // Expired? Throw the whole batch away.
    if (Date.now() - parsed.savedAt > TTL_MS) {
      localStorage.removeItem(STORAGE_KEY);
      return [];
    }
    return parsed.annotations;
  } catch {
    return [];
  }
}

interface AIAnnotationsContextValue {
  annotations: AIAnnotation[];
  visible: boolean;
  focusedId: string | null;
  /** When true, the map shows draggable handles so the user can reshape findings. */
  editing: boolean;
  add: (annotation: Omit<AIAnnotation, "id">) => string;
  clearTurn: (turnId: string) => void;
  clearAll: () => void;
  setVisible: (visible: boolean) => void;
  setEditing: (editing: boolean) => void;
  focusAnnotation: (id: string) => void;
  clearFocus: () => void;
  /** Replace one annotation's args (used while dragging vertices). */
  updateAnnotationArgs: (id: string, args: Record<string, unknown>) => void;
  /** Delete a single annotation. */
  removeAnnotation: (id: string) => void;
}

const AIAnnotationsContext = createContext<AIAnnotationsContextValue | null>(null);

export { labelFromTool, colorFromArgs };

export function AIAnnotationsProvider({ children }: { children: ReactNode }) {
  const [annotations, setAnnotations] = useState<AIAnnotation[]>([]);
  const [visible, setVisible] = useState(true);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  // Hydrate from localStorage after mount. We do this in an effect (not the
  // useState initializer) so the server-rendered HTML and first client render
  // match — reading localStorage during render would risk a hydration mismatch.
  // 📖 Learn: hydration mismatch = server HTML ≠ first client HTML; React warns.
  const hydrated = useRef(false);
  useEffect(() => {
    const restored = loadFromStorage();
    if (restored.length > 0) setAnnotations(restored);
    hydrated.current = true;
  }, []);

  // Persist on every change — but only after the initial hydrate, so we don't
  // immediately overwrite saved data with the empty starting state.
  useEffect(() => {
    if (!hydrated.current) return;
    try {
      if (annotations.length === 0) {
        localStorage.removeItem(STORAGE_KEY);
      } else {
        const envelope: StoredEnvelope = { savedAt: Date.now(), annotations };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(envelope));
      }
    } catch {
      /* quota exceeded — ignore */
    }
  }, [annotations]);

  const add = useCallback((annotation: Omit<AIAnnotation, "id">) => {
    const id = crypto.randomUUID();
    setAnnotations((prev) => [...prev, { ...annotation, id }]);
    setVisible(true);
    return id;
  }, []);

  const clearTurn = useCallback((turnId: string) => {
    setAnnotations((prev) => prev.filter((a) => a.turnId !== turnId));
  }, []);

  const clearAll = useCallback(() => {
    setAnnotations([]);
    setFocusedId(null);
    setVisible(false);
    setEditing(false);
  }, []);

  const updateAnnotationArgs = useCallback(
    (id: string, args: Record<string, unknown>) => {
      setAnnotations((prev) =>
        prev.map((a) => (a.id === id ? { ...a, args } : a)),
      );
    },
    [],
  );

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const focusAnnotation = useCallback((id: string) => {
    setFocusedId(id);
    setVisible(true);
  }, []);

  const clearFocus = useCallback(() => setFocusedId(null), []);

  const value = useMemo(
    () => ({
      annotations,
      visible,
      focusedId,
      editing,
      add,
      clearTurn,
      clearAll,
      setVisible,
      setEditing,
      focusAnnotation,
      clearFocus,
      updateAnnotationArgs,
      removeAnnotation,
    }),
    [
      annotations,
      visible,
      focusedId,
      editing,
      add,
      clearTurn,
      clearAll,
      focusAnnotation,
      clearFocus,
      updateAnnotationArgs,
      removeAnnotation,
    ],
  );

  return (
    <AIAnnotationsContext.Provider value={value}>{children}</AIAnnotationsContext.Provider>
  );
}

export function useAIAnnotations(): AIAnnotationsContextValue {
  const ctx = useContext(AIAnnotationsContext);
  if (!ctx) {
    throw new Error("useAIAnnotations must be used within AIAnnotationsProvider");
  }
  return ctx;
}

// ── Vertex editing helpers ────────────────────────────────────────────────
// These are pure functions on an annotation's `args`. The map component reads
// vertices to render drag handles, and writes them back as the user drags.

export type EditVertex = {
  annId: string;
  /** "vertex" = an existing corner/point; "midpoint" = insert-here handle. */
  role: "vertex" | "midpoint";
  /** Index of the vertex (for midpoints: the segment's start index). */
  index: number;
  lng: number;
  lat: number;
};

/** Every draggable handle for one annotation. flyTo has none (camera only). */
export function editableVertices(ann: AIAnnotation): EditVertex[] {
  const { id, kind, args } = ann;
  if (kind === "pin") {
    const lng = Number(args.lng);
    const lat = Number(args.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return [];
    return [{ annId: id, role: "vertex", index: 0, lng, lat }];
  }
  if (kind === "corridor") {
    const from = args.from as number[] | undefined;
    const to = args.to as number[] | undefined;
    if (!from || !to) return [];
    return [
      { annId: id, role: "vertex", index: 0, lng: Number(from[0]), lat: Number(from[1]) },
      { annId: id, role: "vertex", index: 1, lng: Number(to[0]), lat: Number(to[1]) },
    ];
  }
  if (kind === "highlight" && Array.isArray(args.polygon)) {
    const ring = args.polygon as number[][];
    const verts: EditVertex[] = ring.map((p, i) => ({
      annId: id,
      role: "vertex" as const,
      index: i,
      lng: Number(p[0]),
      lat: Number(p[1]),
    }));
    // Midpoint handle between each pair of adjacent vertices (wraps around).
    const mids: EditVertex[] = ring.map((p, i) => {
      const next = ring[(i + 1) % ring.length]!;
      return {
        annId: id,
        role: "midpoint" as const,
        index: i,
        lng: (Number(p[0]) + Number(next[0])) / 2,
        lat: (Number(p[1]) + Number(next[1])) / 2,
      };
    });
    return [...verts, ...mids];
  }
  return [];
}

/** Move an existing vertex to a new position; returns updated args. */
export function moveVertex(
  ann: AIAnnotation,
  index: number,
  lng: number,
  lat: number,
): Record<string, unknown> {
  const { kind, args } = ann;
  if (kind === "pin") return { ...args, lng, lat };
  if (kind === "corridor") {
    // Dragging an endpoint invalidates the server's road-snapped path, so we
    // drop it and fall back to the straight from→to line (honest, not stale).
    const { path: _dropped, ...rest } = args;
    return index === 0
      ? { ...rest, from: [lng, lat] }
      : { ...rest, to: [lng, lat] };
  }
  if (kind === "highlight" && Array.isArray(args.polygon)) {
    const ring = (args.polygon as number[][]).map((p) => [Number(p[0]), Number(p[1])]);
    if (ring[index]) ring[index] = [lng, lat];
    return { ...args, polygon: ring };
  }
  return args;
}

/** Insert a new vertex after `segmentIndex` (polygon only). */
export function insertVertex(
  ann: AIAnnotation,
  segmentIndex: number,
  lng: number,
  lat: number,
): Record<string, unknown> {
  if (ann.kind !== "highlight" || !Array.isArray(ann.args.polygon)) return ann.args;
  const ring = (ann.args.polygon as number[][]).map((p) => [Number(p[0]), Number(p[1])]);
  ring.splice(segmentIndex + 1, 0, [lng, lat]);
  return { ...ann.args, polygon: ring };
}

/** Delete a vertex (polygon only, keeps a minimum of 3 corners). */
export function deleteVertex(ann: AIAnnotation, index: number): Record<string, unknown> | null {
  if (ann.kind !== "highlight" || !Array.isArray(ann.args.polygon)) return null;
  const ring = (ann.args.polygon as number[][]).map((p) => [Number(p[0]), Number(p[1])]);
  if (ring.length <= 3) return null; // a polygon needs at least 3 corners
  ring.splice(index, 1);
  return { ...ann.args, polygon: ring };
}

/** Bbox [west, south, east, north] for flying the camera to an annotation. */
export function annotationBbox(
  ann: AIAnnotation,
): [number, number, number, number] | null {
  const { kind, args } = ann;
  if (kind === "flyTo" && Array.isArray(args.bbox) && args.bbox.length >= 4) {
    return args.bbox.slice(0, 4).map(Number) as [number, number, number, number];
  }
  if (kind === "pin") {
    const lng = Number(args.lng);
    const lat = Number(args.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const pad = 0.01;
    return [lng - pad, lat - pad, lng + pad, lat + pad];
  }
  if (kind === "corridor") {
    const from = args.from as number[] | undefined;
    const to = args.to as number[] | undefined;
    if (!from || !to) return null;
    const lngs = [from[0]!, to[0]!];
    const lats = [from[1]!, to[1]!];
    const pad = 0.008;
    return [
      Math.min(...lngs) - pad,
      Math.min(...lats) - pad,
      Math.max(...lngs) + pad,
      Math.max(...lats) + pad,
    ];
  }
  if (kind === "highlight" && Array.isArray(args.polygon)) {
    const ring = args.polygon as number[][];
    const lngs = ring.map((p) => p[0]!);
    const lats = ring.map((p) => p[1]!);
    if (lngs.length === 0) return null;
    return [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)];
  }
  return null;
}
