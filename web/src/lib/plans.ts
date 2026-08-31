import type { Route } from "~/app/map/transit-data";

export type PlanSession = {
  id: string;
  name: string;
  routes: Route[];
  hiddenRoutes: string[];
  /**
   * Transfers the user dismissed, as "routeA:routeB:stopName" keys.
   *
   * Stored in the optional `transfer_exclusions` jsonb column. Reads tolerate
   * its absence (see isMissingColumnError) so the app keeps working on a
   * database where the column hasn't been added yet.
   */
  transferExclusions: string[];
  createdAt: string;
  updatedAt: string;
};

/** The `plan_sessions` columns that are guaranteed to exist. */
export type PlanRow = {
  id: string;
  name: string;
  routes: Route[];
  hidden_routes: string[] | null;
  created_at: string;
  updated_at: string;
};

/**
 * Map a raw row to the API shape.
 *
 * `transferExclusions` is passed in rather than read off the row: write paths
 * already know the value from the request, and keeping it out of their select
 * lists means those queries work on a database that lacks the column.
 */
export function rowToPlanSession(row: PlanRow, transferExclusions: string[]): PlanSession {
  return {
    id: row.id,
    name: row.name,
    routes: row.routes,
    hiddenRoutes: row.hidden_routes ?? [],
    transferExclusions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type PlanSessionSummary = {
  id: string;
  name: string;
  routeCount: number;
  createdAt: string;
  updatedAt: string;
};

export type CreatePlanBody = {
  name: string;
  routes: Route[];
  hiddenRoutes: string[];
  transferExclusions?: string[];
};

export type UpdatePlanBody = {
  name?: string;
  routes?: Route[];
  hiddenRoutes?: string[];
  transferExclusions?: string[];
};

/**
 * True when Postgres/PostgREST rejected a query because `transfer_exclusions`
 * doesn't exist yet.
 *
 * The column is added out-of-band in the Supabase dashboard:
 *   alter table plan_sessions add column transfer_exclusions jsonb default '[]'::jsonb;
 *
 * Until then, writes retry without the field rather than failing the save.
 * PGRST204 = column missing from PostgREST's schema cache; 42703 = undefined
 * column from Postgres itself.
 */
export function isMissingColumnError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return (
    error.code === "PGRST204" ||
    error.code === "42703" ||
    (error.message?.includes("transfer_exclusions") ?? false)
  );
}
