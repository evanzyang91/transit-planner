import { env } from "~/env.js";
import { isStagingHost } from "~/server/is-staging-host";

type DiscordColor =
  | "green"
  | "blue"
  | "yellow"
  | "red"
  | "purple"
  | "gray";

const COLOR_MAP: Record<DiscordColor, number> = {
  green: 0x57f287,
  blue: 0x5865f2,
  yellow: 0xfee75c,
  red: 0xed4245,
  purple: 0x9b59b6,
  gray: 0x95a5a6,
};

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: EmbedField[];
  footer?: { text: string };
  timestamp?: string;
}

// `host` is the requesting browser's Host header, passed in explicitly by
// each caller (see trackChatMessage etc. below) rather than looked up here,
// so it's obvious at every call site where the value comes from.
async function sendWebhook(
  host: string | null,
  embeds: DiscordEmbed[],
): Promise<void> {
  const url = env.DISCORD_WEBHOOK_URL;
  if (!url) return;
  if (isStagingHost(host)) return;
  if (env.NODE_ENV !== "production") return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds }),
    });
  } catch (err) {
    console.error("[discord] webhook failed:", err);
  }
}

export async function trackUserSignIn(
  host: string | null,
  user: {
    name?: string | null;
    email?: string | null;
    isNew?: boolean;
  },
): Promise<void> {
  const color: DiscordColor = user.isNew ? "green" : "blue";
  const title = user.isNew ? "New User Signed Up" : "User Signed In";

  await sendWebhook(host, [
    {
      title,
      color: COLOR_MAP[color],
      fields: [
        { name: "Name", value: user.name ?? "Unknown", inline: true },
        { name: "Email", value: user.email ?? "Unknown", inline: true },
      ],
      timestamp: new Date().toISOString(),
    },
  ]);
}

export async function trackCouncilRequest(
  host: string | null,
  opts: {
    neighbourhoods: string[];
    lineType?: string | null;
    stationCount: number;
  },
): Promise<void> {
  await sendWebhook(host, [
    {
      title: "Council Planning Request",
      color: COLOR_MAP.purple,
      fields: [
        {
          name: "Line Type",
          value: opts.lineType ?? "unspecified",
          inline: true,
        },
        {
          name: "Stations",
          value: String(opts.stationCount),
          inline: true,
        },
        {
          name: "Neighbourhoods",
          value:
            opts.neighbourhoods.length > 0
              ? opts.neighbourhoods.slice(0, 5).join(", ") +
                (opts.neighbourhoods.length > 5
                  ? ` +${opts.neighbourhoods.length - 5} more`
                  : "")
              : "none",
        },
      ],
      timestamp: new Date().toISOString(),
    },
  ]);
}

export async function trackChatMessage(
  host: string | null,
  opts: {
    message: string;
    model?: string;
  },
): Promise<void> {
  const preview =
    opts.message.length > 200
      ? opts.message.slice(0, 200) + "…"
      : opts.message;

  await sendWebhook(host, [
    {
      title: "Chat Message",
      color: COLOR_MAP.gray,
      fields: [
        { name: "Model", value: opts.model ?? "default", inline: true },
        { name: "Message", value: preview },
      ],
      timestamp: new Date().toISOString(),
    },
  ]);
}
