import { NextResponse } from "next/server";
import { env } from "~/env.js";

export async function POST(req: Request) {
  let body: { message?: unknown; category?: unknown; name?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const category =
    typeof body.category === "string" ? body.category.trim() : "General";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const isBugReport = category.toLowerCase() === "bug report";
  const webhookUrl = isBugReport
    ? env.DISCORD_BUG_REPORTS_WEBHOOK_URL
    : env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    return NextResponse.json(
      { error: "Feedback not configured" },
      { status: 503 },
    );
  }

  if (!message || message.length > 2000) {
    return NextResponse.json(
      { error: "Message required (max 2000 chars)" },
      { status: 400 },
    );
  }

  const embed = {
    title: `[${category}] Feedback`,
    description: message,
    color: 0x6366f1,
    fields: name ? [{ name: "From", value: name, inline: true }] : [],
    timestamp: new Date().toISOString(),
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    return NextResponse.json({ error: "Failed to send" }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
