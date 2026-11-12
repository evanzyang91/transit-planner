/**
 * Number formatting for the chat's draft-line card. Pure functions, unit-tested.
 * Missing values (the server may omit optional stats) show as an em dash.
 */

const MISSING = "—";

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** 12.3 km · 0.85 km · 120 km */
export function formatKm(km: number | undefined): string {
  if (!isNumber(km)) return MISSING;
  if (km < 1) return `${km.toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}

/** $1.2B · $450M · $3M (input is in billions of dollars, as in DraftLine.stats) */
export function formatCost(billions: number | undefined): string {
  if (!isNumber(billions)) return MISSING;
  if (billions >= 1) return `$${billions.toFixed(1)}B`;
  const millions = billions * 1000;
  return `$${Math.max(1, Math.round(millions))}M`;
}

/** 950 · 85k · 1.2M people */
export function formatPopulation(count: number | undefined): string {
  if (!isNumber(count)) return MISSING;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`;
  return String(Math.round(count));
}

/**
 * The line colour comes from the model (via the server), so only accept a
 * plain hex colour before putting it in a style. Anything else — including a
 * sneaky `url(...)` that would make the browser fetch something — falls back
 * to the AI teal.
 */
export function safeHexColor(color: string, fallback = "#14b8a6"): string {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : fallback;
}
