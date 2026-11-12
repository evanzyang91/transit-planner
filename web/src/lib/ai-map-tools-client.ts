/** Shared map-tool helpers (safe for client + server). */

/**
 * What a project reset leaves behind: "default" restores the baseline TTC
 * network (the original Settings → Reset behaviour), "empty" removes every
 * route and station. Shared so the reset_network tool, the chat panel and the
 * confirm dialog can't disagree on the spelling.
 */
export type ResetTarget = "default" | "empty";

export function isResetTarget(value: unknown): value is ResetTarget {
  return value === "default" || value === "empty";
}

export const COLOR_HEX: Record<string, string> = {
  red: "#ef4444",
  amber: "#f59e0b",
  teal: "#14b8a6",
  emerald: "#10b981",
  sky: "#0ea5e9",
};

export function toolNameToKind(
  name: string,
): "highlight" | "corridor" | "pin" | "flyTo" | null {
  switch (name) {
    case "highlight_area":
      return "highlight";
    case "draw_corridor":
      return "corridor";
    case "drop_pin":
      return "pin";
    case "fly_to":
      return "flyTo";
    default:
      return null;
  }
}

export function labelFromTool(name: string, args: Record<string, unknown>): string {
  if (typeof args.label === "string" && args.label) return args.label;
  if (typeof args.note === "string" && args.note) return args.note;
  if (typeof args.reason === "string" && args.reason) return args.reason;
  return name.replace(/_/g, " ");
}

/**
 * An annotation ready for AIAnnotationsContext's add() — everything except the
 * id, which add() creates. Declared here structurally (instead of importing the
 * React context's type) so this file stays safe to import on the server.
 */
export interface AnnotationInput {
  kind: "highlight" | "corridor" | "pin" | "flyTo";
  args: Record<string, unknown>;
  /** The chat turn that drew it — the chat shows its chips under that reply. */
  turnId: string;
  label: string;
  color?: string;
}

/**
 * Turns a drawing tool_call (highlight_area, draw_corridor, drop_pin, fly_to)
 * into an annotation for the map. Returns null for any other tool name — app
 * actions such as reset_network are NOT annotations and go to TransitMap.
 * (Moved here from the deleted useAnthropic.ts.)
 */
export function mapToolToAnnotation(
  name: string,
  args: Record<string, unknown>,
  turnId: string,
): AnnotationInput | null {
  const kind = toolNameToKind(name);
  if (!kind) return null;
  return {
    kind,
    args,
    turnId,
    label: labelFromTool(name, args),
    color: colorFromArgs(args),
  };
}

export function colorFromArgs(args: Record<string, unknown>): string | undefined {
  if (typeof args.color === "string" && args.color in COLOR_HEX) {
    return COLOR_HEX[args.color];
  }
  if (typeof args.mode === "string") {
    const modeColors: Record<string, string> = {
      subway: "#6366f1",
      lrt: "#8b5cf6",
      streetcar: "#f59e0b",
      bus: "#10b981",
      rail: "#0ea5e9",
    };
    return modeColors[args.mode];
  }
  return undefined;
}
