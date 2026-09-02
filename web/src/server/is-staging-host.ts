// test.<domain> is our staging subdomain. The client already skips its own
// tracking calls there (see ~/lib/track.ts), but that check lives in the
// browser and can't stop someone — or a bug — from hitting the API routes
// directly. This is the server-side twin: every code path that can reach a
// Discord webhook calls this first, using the incoming request's Host header
// rather than NODE_ENV, because NODE_ENV is always "production" for any
// built/deployed Next.js app (staging included) and can't tell them apart.
export function isStagingHost(host: string | null | undefined): boolean {
  return (host ?? "").toLowerCase().startsWith("test.");
}
