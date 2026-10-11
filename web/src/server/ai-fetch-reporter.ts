import type { NextRequest } from "next/server";
import { matchAiFetcher } from "~/lib/ai-assistants";
import { isStagingHost } from "~/server/is-staging-host";

// Called from middleware on every request. Spots AI assistants fetching our
// pages server-side (ChatGPT-User, GPTBot, ClaudeBot…), which the browser
// tracker can never see because these fetchers don't run JavaScript.
//
// Two outputs, on purpose:
// 1. EVERY AI fetch → one JSON line in the Vercel runtime logs. Search the
//    logs for "ai_fetch" to see which pages each assistant reads. Cheap, but
//    Vercel only keeps runtime logs for a short window.
// 2. Only "user" fetches → Discord. Each one means a real person asked an
//    assistant something and it opened this page to answer — rare, and worth
//    keeping. Training/search crawlers would flood the channel, so they're
//    logs-only.
//
// Returns the pending Discord request (for event.waitUntil) or null.
//
// Reads process.env directly rather than ~/env.js, matching ~/lib/auth0.ts:
// middleware is bundled separately, and env.js would drag in validation of
// every required server variable.
export function reportAiFetch(request: NextRequest): Promise<void> | null {
  const fetcher = matchAiFetcher(request.headers.get("user-agent"));
  if (!fetcher) return null;

  const page = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  // One line of JSON per hit, so the logs are filterable/greppable.
  console.log(
    JSON.stringify({
      type: "ai_fetch",
      vendor: fetcher.vendor,
      bot: fetcher.token,
      kind: fetcher.kind,
      page,
    }),
  );

  if (fetcher.kind !== "user") return null;
  if (process.env.NODE_ENV !== "production") return null;
  if (isStagingHost(request.headers.get("host"))) return null;

  const webhookUrl =
    process.env.DISCORD_AI_VISITS_WEBHOOK_URL ??
    process.env.DISCORD_REFERRAL_VISITS_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const embed = {
    title: `🔎 ${fetcher.token} read ${request.nextUrl.pathname} for someone`,
    color: 0x14b8a6, // teal = AI, same as AI-assistant visits in /api/track
    fields: [
      { name: "🤖 Assistant", value: fetcher.vendor, inline: true },
      { name: "📄 Page", value: page, inline: true },
      { name: "🕒 Time", value: new Date().toISOString(), inline: true },
    ],
    timestamp: new Date().toISOString(),
  };

  return fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed] }),
  })
    .then(() => undefined)
    .catch((err: unknown) => {
      // Best-effort — tracking must never affect the actual response.
      console.error("[ai-fetch] Discord webhook failed:", err);
    });
}
