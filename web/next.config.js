import path from "node:path";
import { fileURLToPath } from "node:url";

import nextEnv from "@next/env";
const { loadEnvConfig } = nextEnv;

/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Load .env from repo root (one level above /web) before validating env schema
loadEnvConfig(projectRoot);

await import("./src/env.js");

const isDev = process.env.NODE_ENV !== "production";

// Script sources we allow ONLY while developing (production gets neither):
// - 'unsafe-eval': the dev bundler's hot-reload / source-map code uses eval().
// - https://va.vercel-scripts.com: in development, Vercel Analytics and Speed
//   Insights load their *debug* scripts from this host, and the CSP was blocking
//   them on every page. In production they load from our own origin
//   (/_vercel/...), which 'self' already covers.
const devOnlyScriptSources = isDev
  ? " 'unsafe-eval' https://va.vercel-scripts.com"
  : "";

const cspDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' https://fonts.gstatic.com data:",
  `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com${isDev ? " https:" : ""}`,
  `script-src 'self' 'unsafe-inline'${devOnlyScriptSources} https://cdn.jsdelivr.net`,
  "connect-src 'self' https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com https://fonts.googleapis.com https://fonts.gstatic.com",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  "frame-src 'self'",
  "manifest-src 'self'",
];

// `upgrade-insecure-requests` makes the browser rewrite every http:// request
// the page makes (JS chunks, CSS, fetches) to https://. Production is always
// served over HTTPS, so there it's a cheap safety net. But `next dev` only
// speaks plain http. Browsers exempt "localhost", but on any other origin (a
// LAN IP like 192.168.x.x, a phone, and possibly Safari even on localhost)
// every chunk URL became https://… and failed with an SSL error. The page
// never hydrated, and "Start Mapping" led to an SSL error page. So we send it
// in production only.
// 📖 Learn: upgrade-insecure-requests — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/upgrade-insecure-requests
if (!isDev) {
  cspDirectives.push("upgrade-insecure-requests");
}

const csp = cspDirectives.join("; ");

// Hosts other than "localhost" that may use the DEV server's internal /_next/*
// files and its hot-reload websocket. This lets a phone or a second computer on
// the same Wi-Fi open http://192.168.x.x:3000 without warnings, and keeps
// working once a future Next.js version blocks unlisted hosts by default.
// `next build` / `next start` ignore this option entirely.
//
// ⚠️ Tradeoff: as soon as this list exists, Next switches from "warn" to
// "block" for every host NOT listed. That's why 127.0.0.1 and [::1] are here
// (Next only has "localhost" built in). If you test through a tunnel (ngrok,
// Tailscale, a custom hostname), add that hostname here or hot reload stops
// working there.
//
// Only private (RFC 1918) ranges are listed: no website on the public internet
// can be served from them, so this doesn't let a random site read your dev
// files. Next's wildcards match whole dot-separated parts, which is why
// 172.16–172.31 is spelled out instead of using "172.*.*.*" (that would also
// match public addresses).
// 📖 Learn: allowedDevOrigins — https://nextjs.org/docs/app/api-reference/config/next-config-js/allowedDevOrigins
// 📖 Learn: private IPv4 ranges (RFC 1918) — https://en.wikipedia.org/wiki/Private_network
const privateNetworkDevOrigins = [
  "127.0.0.1",
  "[::1]", // IPv6 loopback
  "10.*.*.*",
  "192.168.*.*",
  "*.local", // macOS/Bonjour names, e.g. "my-macbook.local"
];
for (let secondOctet = 16; secondOctet <= 31; secondOctet++) {
  privateNetworkDevOrigins.push(`172.${secondOctet}.*.*`);
}

/** @type {import("next").NextConfig} */
const config = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "s.gravatar.com" },
    ],
  },
  devIndicators: false,
  allowedDevOrigins: privateNetworkDevOrigins,
  turbopack: {
    root: path.resolve(__dirname, ".."),
  },
  typescript: {
    // ⚠️ Allows production builds to succeed even with TS errors
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "Content-Security-Policy",
            value: csp.replace(/\s{2,}/g, " ").trim(),
          },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(self)" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Resource-Policy", value: "same-site" },
        ],
      },
    ];
  },
};

export default config;
