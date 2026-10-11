// Client helper that sends a named event to /api/track, which forwards it to
// Discord server-side. Call from any client component for clicks, etc.
//
// Note: this is separate from ~/lib/analytics (Mixpanel). We name it
// `trackVisit` rather than `trackEvent` so the two don't get confused.
//
// Why a plain function instead of a hook? Hooks must run at the top level of a
// component and can't be called inside event handlers. A plain async function
// has no such rules.
// 📖 Learn: Rules of Hooks — https://react.dev/reference/rules/rules-of-hooks

export type VisitWebhookType =
  | "regular_visit"
  | "referral_visit"
  | "ai_referral_visit";

export function trackVisit(
  event: string,
  meta?: Record<string, string>,
  webhookType: VisitWebhookType = "regular_visit",
) {
  if (typeof window === "undefined") return;
  if (window.location.hostname === "localhost") return;
  // test.<domain> is our staging subdomain — never report its traffic.
  if (window.location.hostname.startsWith("test.")) return;
  if (localStorage.getItem("skip_tracking")) return;

  // fire-and-forget — we never await or surface errors to the user
  void fetch("/api/track", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ event, meta, webhookType }),
  }).catch(() => {
    // silently swallow network errors — tracking should never break the UI
  });
}
