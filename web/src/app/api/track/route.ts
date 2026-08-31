import type { NextRequest } from "next/server";
import { env } from "~/env.js";

type VisitWebhookType = "regular_visit" | "referral_visit";

function getVisitWebhookType(opts: {
  event: string;
  meta: Record<string, string>;
  webhookType?: VisitWebhookType;
}): VisitWebhookType {
  if (opts.webhookType === "referral_visit") return "referral_visit";

  const url = opts.meta["🔗 URL"];
  const params = opts.meta["🔗 Params"];
  if (params) return "referral_visit";
  if (url?.includes("?")) return "referral_visit";
  if (/from \*\*.+\*\*|CUSTOM REFERRAL/i.test(opts.event)) {
    return "referral_visit";
  }

  return "regular_visit";
}

// POST /api/track  — body: { event: string, meta?: Record<string, string> }
//
// Why a server route instead of calling Discord from the browser?
// The webhook URL is a secret — anyone with it can post to the channel.
// Routing through here keeps the URL in process.env (server memory) so it
// never ships in the JS bundle the browser downloads.
// 📖 Learn: Next.js Route Handlers — https://nextjs.org/docs/app/building-your-application/routing/route-handlers

export async function POST(req: NextRequest) {
  const {
    event,
    meta = {},
    webhookType,
  } = (await req.json()) as {
    event: string;
    meta?: Record<string, string>;
    webhookType?: VisitWebhookType;
  };

  const visitWebhookType = getVisitWebhookType({ event, meta, webhookType });
  const webhookUrl =
    visitWebhookType === "referral_visit"
      ? env.DISCORD_REFERRAL_VISITS_WEBHOOK_URL
      : (env.DISCORD_REGULAR_VISITS_WEBHOOK_URL ?? env.DISCORD_WEBHOOK_URL);

  // No secret configured (e.g. fresh clone) → do nothing. Tracking is non-critical.
  if (!webhookUrl) {
    return new Response(null, { status: 204 });
  }

  // Vercel injects visitor geolocation as x-vercel-ip-* headers at the edge.
  // Reading them server-side avoids a client-side IP lookup and keeps it free.
  // 📖 Learn: edge geo headers — https://vercel.com/docs/edge-network/headers#x-vercel-ip-country
  const h = req.headers;
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const country = h.get("x-vercel-ip-country");
  const region = h.get("x-vercel-ip-country-region");
  const city = h.get("x-vercel-ip-city");
  const latitude = h.get("x-vercel-ip-latitude");
  const longitude = h.get("x-vercel-ip-longitude");
  const postalCode = h.get("x-vercel-ip-postal-code");
  const timezone = h.get("x-vercel-ip-timezone");

  const enrichedMeta: Record<string, string> = {
    ...meta,
    ...(ip ? { "🌐 IP": ip } : {}),
    ...(country ? { "🌍 Country": country } : {}),
    ...(region ? { "🗺️ Region": region } : {}),
    ...(city ? { "🏙️ City": decodeURIComponent(city) } : {}),
    ...(latitude && longitude
      ? { "📍 Coordinates": `${latitude}, ${longitude}` }
      : {}),
    ...(postalCode ? { "📮 Postal": postalCode } : {}),
    ...(timezone ? { "🕒 Timezone": timezone } : {}),
  };

  // Send a Discord embed (the colored card) to stay consistent with the rest of
  // the app's webhooks in ~/server/discord.ts. Each meta key/value becomes an
  // inline field. `inline: true` lets Discord pack ~3 fields per row.
  // 📖 Learn: Discord embed structure — https://discord.com/developers/docs/resources/message#embed-object
  const fields = Object.entries(enrichedMeta).map(([name, value]) => ({
    name,
    value: String(value),
    inline: true,
  }));

  const embed = {
    title: event,
    color: 0x5865f2, // Discord "blurple" — matches the blue used elsewhere
    fields,
    timestamp: new Date().toISOString(),
  };

  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    // Best-effort — never surface tracking failures to the client.
    console.error("Failed to forward event to Discord:", err);
  }

  // 204 No Content — the client doesn't need a response body.
  return new Response(null, { status: 204 });
}
