import { NextResponse } from "next/server";
import { auth0 } from "~/lib/auth0";
import { supabase } from "~/server/supabase";
import { isMissingColumnError, rowToPlanSession, type CreatePlanBody, type PlanSessionSummary } from "~/lib/plans";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth0.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.sub;

  const { data, error } = await supabase
    .from("plan_sessions")
    .select("id, name, routes, created_at, updated_at")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const summaries: PlanSessionSummary[] = (data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    routeCount: Array.isArray(row.routes) ? (row.routes as unknown[]).length : 0,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }));

  return NextResponse.json(summaries);
}

export async function POST(req: Request) {
  const session = await auth0.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.sub;

  let body: CreatePlanBody;
  try {
    body = (await req.json()) as CreatePlanBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, routes, hiddenRoutes, transferExclusions } = body;
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }
  if (!Array.isArray(routes)) {
    return NextResponse.json({ error: "Routes must be an array" }, { status: 400 });
  }

  const base = {
    user_id: userId,
    name: name.trim(),
    routes,
    hidden_routes: Array.isArray(hiddenRoutes) ? hiddenRoutes : [],
  };

  const exclusions = Array.isArray(transferExclusions) ? transferExclusions : [];

  // The select list deliberately omits transfer_exclusions: we already know the
  // value (it came from the request), so reading it back would make this query
  // fail on a database where the column doesn't exist yet. Only the *insert*
  // needs the fallback below.
  let { data, error } = await supabase
    .from("plan_sessions")
    .insert({ ...base, transfer_exclusions: exclusions })
    .select("id, name, routes, hidden_routes, created_at, updated_at")
    .single();

  // Older database without the column — save the plan anyway, minus dismissals.
  let savedExclusions = exclusions;
  if (isMissingColumnError(error)) {
    savedExclusions = [];
    ({ data, error } = await supabase
      .from("plan_sessions")
      .insert(base)
      .select("id, name, routes, hidden_routes, created_at, updated_at")
      .single());
  }

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Insert failed" }, { status: 500 });
  }

  return NextResponse.json(rowToPlanSession(data, savedExclusions), { status: 201 });
}
