import { NextResponse } from "next/server";
import { auth0 } from "~/lib/auth0";
import { supabase } from "~/server/supabase";
import { isMissingColumnError, rowToPlanSession, type UpdatePlanBody } from "~/lib/plans";

export const dynamic = "force-dynamic";

async function verifyOwnership(id: string, userId: string) {
  const { data, error } = await supabase
    .from("plan_sessions")
    .select("id, user_id")
    .eq("id", id)
    .single();

  if (error || !data) return { ok: false, status: 404 };
  if ((data.user_id as string) !== userId) return { ok: false, status: 403 };
  return { ok: true, status: 200 };
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth0.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.sub;
  const { id } = await params;

  const ownership = await verifyOwnership(id, userId);
  if (!ownership.ok) {
    return NextResponse.json({ error: ownership.status === 404 ? "Not found" : "Forbidden" }, { status: ownership.status });
  }

  // This is the one place that must actually read transfer_exclusions, so it's
  // the one place that needs a fallback select for databases without it.
  const withExclusions = await supabase
    .from("plan_sessions")
    .select("id, name, routes, hidden_routes, created_at, updated_at, transfer_exclusions")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (!isMissingColumnError(withExclusions.error)) {
    if (withExclusions.error || !withExclusions.data) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const row = withExclusions.data;
    // Supabase has no schema type for this column, so narrow it explicitly.
    const exclusions = Array.isArray(row.transfer_exclusions)
      ? (row.transfer_exclusions as string[])
      : [];
    return NextResponse.json(rowToPlanSession(row, exclusions));
  }

  const { data, error } = await supabase
    .from("plan_sessions")
    .select("id, name, routes, hidden_routes, created_at, updated_at")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (error || !data) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(rowToPlanSession(data, []));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth0.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.sub;
  const { id } = await params;

  const ownership = await verifyOwnership(id, userId);
  if (!ownership.ok) {
    return NextResponse.json({ error: ownership.status === 404 ? "Not found" : "Forbidden" }, { status: ownership.status });
  }

  let body: UpdatePlanBody;
  try {
    body = (await req.json()) as UpdatePlanBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim().length === 0) {
      return NextResponse.json({ error: "Name must be a non-empty string" }, { status: 400 });
    }
    update.name = body.name.trim();
  }
  if (body.routes !== undefined) update.routes = body.routes;
  if (body.hiddenRoutes !== undefined) update.hidden_routes = body.hiddenRoutes;
  if (body.transferExclusions !== undefined) update.transfer_exclusions = body.transferExclusions;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // As in POST: don't read transfer_exclusions back, we already have it.
  let { data, error } = await supabase
    .from("plan_sessions")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId)
    .select("id, name, routes, hidden_routes, created_at, updated_at")
    .single();

  // Older database without the column — persist everything else rather than
  // failing the user's save.
  let savedExclusions = body.transferExclusions ?? [];
  if (isMissingColumnError(error)) {
    savedExclusions = [];
    const rest = { ...update };
    delete rest.transfer_exclusions;
    if (Object.keys(rest).length === 0) {
      return NextResponse.json({ error: "No fields to update" }, { status: 400 });
    }
    ({ data, error } = await supabase
      .from("plan_sessions")
      .update(rest)
      .eq("id", id)
      .eq("user_id", userId)
      .select("id, name, routes, hidden_routes, created_at, updated_at")
      .single());
  }

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }

  return NextResponse.json(rowToPlanSession(data, savedExclusions));
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth0.getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = session.user.sub;
  const { id } = await params;

  const ownership = await verifyOwnership(id, userId);
  if (!ownership.ok) {
    return NextResponse.json({ error: ownership.status === 404 ? "Not found" : "Forbidden" }, { status: ownership.status });
  }

  const { error } = await supabase
    .from("plan_sessions")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
