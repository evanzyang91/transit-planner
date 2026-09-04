"use client";

import { useEffect, useRef } from "react";
import { trackVisit } from "~/lib/track";

// ─── Edit this to add/rename referral sources ─────────────────────────────────
// key   = the URL query param (e.g. "l" matches "?l" or "?l=anything")
// value = display name shown (bolded) in the Discord message
const REFERRAL_SOURCES: Record<string, string> = {
  l: "LinkedIn",
  r: "Resume",
  t: "Twitter/X",
  e: "Email",
  g: "GitHub",
  c: "Cover Letter",
};
// ──────────────────────────────────────────────────────────────────────────────

// ─── UTM-style referral links ───────────────────────────────────────────────
// Some links (e.g. a resume/CV, a QR code, a link shortener) use the
// conventional ?utm_source=<value> format instead of the single-letter
// shorthand above. This map is keyed by the utm_source VALUE (lowercased),
// not the param name — add an entry here for each new UTM link you create.
const UTM_SOURCE_LABELS: Record<string, string> = {
  resume: "Resume",
};
// ──────────────────────────────────────────────────────────────────────────────

const TRACKING_OPT_OUT_KEY = "skip_tracking";
const TRACKING_OPT_OUT_PARAM = "m";
const REFERRAL_KEY = "referral_source";

// Named a "CUSTOM REFERRAL" when the query params don't match anything in
// REFERRAL_SOURCES or UTM_SOURCE_LABELS above — rather than reporting that
// with no detail, name whatever we do have: the utm_source value even if
// it's one we haven't given a friendly label to yet, else the first param's
// value, else its key (e.g. a bare "?promo" with no value).
function describeCustomReferral(params: URLSearchParams): string {
  const utmSource = params.get("utm_source");
  if (utmSource) return utmSource.toUpperCase();

  const [firstKey, firstValue] = params.entries().next().value ?? [];
  return (firstValue || firstKey || "unknown").toUpperCase();
}

// Fires a Discord webhook once per page load to log visitor info.
// Using a ref (not state) for `hasTracked` avoids a re-render — it's a mutable
// value we only read internally.
// 📖 Learn: useRef for mutable values — https://react.dev/reference/react/useRef#referencing-a-value-with-a-ref
export function usePageViewTracker() {
  const hasTracked = useRef(false);
  // Holding "/" suppresses the tracker — handy for testing on a live URL.
  const slashKeyHeld = useRef(false);

  useEffect(() => {
    // Capture the full URL up front, before anything below strips params from
    // it, so the Discord log shows exactly what the visitor landed on.
    const fullUrl = window.location.href;
    const params = new URLSearchParams(window.location.search);

    // "m" is a "please don't track me" signal, not a referral source — pull
    // it out before computing the referral label below.
    if (params.has(TRACKING_OPT_OUT_PARAM)) {
      localStorage.setItem(TRACKING_OPT_OUT_KEY, "1");
      params.delete(TRACKING_OPT_OUT_PARAM);
    }

    // Referral sticks for the whole visit (and future visits): we persist it in
    // localStorage and fall back to the stored value when the current URL has no
    // param — so a page view on a later page still reports the original source.
    // A fresh referral param always wins and overwrites the stored one.
    // localStorage (not sessionStorage) → survives new tabs and return visits.
    // 📖 Learn: Web Storage API — https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage
    let referralSource: string | null = localStorage.getItem(REFERRAL_KEY);
    for (const key of params.keys()) {
      if (REFERRAL_SOURCES[key]) {
        referralSource = REFERRAL_SOURCES[key];
        localStorage.setItem(REFERRAL_KEY, referralSource); // new param overwrites old
        break;
      }
    }
    // utm_source is matched by its VALUE, not its key, so it's checked
    // separately from the loop above. A fresh utm_source always wins, same
    // as the shorthand params, since it reflects the link just clicked.
    const utmSource = params.get("utm_source")?.toLowerCase();
    if (utmSource && UTM_SOURCE_LABELS[utmSource]) {
      referralSource = UTM_SOURCE_LABELS[utmSource];
      localStorage.setItem(REFERRAL_KEY, referralSource);
    }

    const rawParams = params.toString();

    // Wipe every tracking param from the URL bar unconditionally. This is a
    // cosmetic cleanup, not a tracking action, so it must NOT be gated behind
    // the localhost/staging/opt-out checks in sendVisit() below — otherwise an
    // opted-out visitor (or anyone on localhost/staging) would keep seeing
    // ?utm_source=... in their address bar forever, since nothing else would
    // ever remove it. replaceState rewrites the URL without a reload and
    // without adding a history entry (back button unaffected).
    // 📖 Learn: history.replaceState — https://developer.mozilla.org/en-US/docs/Web/API/History/replaceState
    if (window.location.search) {
      window.history.replaceState(
        {},
        "",
        `${window.location.pathname}${window.location.hash}`,
      );
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "/") slashKeyHeld.current = true;
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "/") slashKeyHeld.current = false;
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);

    // ─── Bounce detection ───────────────────────────────────────────────────
    // A "bounce" = the visitor saw only this one page and left quickly (<10s)
    // without clicking through anywhere. We check at the moment the page is
    // unloading. `pagehide` is the reliable "page is going away" signal (covers
    // both tab close and navigation away).
    // 📖 Learn: Page Lifecycle API — https://developer.chrome.com/docs/web-platform/page-lifecycle-api
    const BOUNCE_THRESHOLD_MS = 10_000; // under 10s on a single page = a bounce
    const pageEnteredAt = Date.now();

    const reportBounceOnExit = () => {
      // Same skip rules as the page-view tracker so we stay consistent.
      if (slashKeyHeld.current) return;
      if (window.location.hostname === "localhost") return;
      // test.<domain> is our staging subdomain — never report its traffic.
      if (window.location.hostname.startsWith("test.")) return;
      if (localStorage.getItem(TRACKING_OPT_OUT_KEY)) return;
      if (/bot|crawler|spider/i.test(navigator.userAgent)) return;

      // Only a bounce if they never left this first page…
      const stored = sessionStorage.getItem("nav_path");
      const pages: string[] = stored ? (JSON.parse(stored) as string[]) : [];
      if (pages.length > 1) return;
      // …and they left quickly.
      const elapsed = Date.now() - pageEnteredAt;
      if (elapsed > BOUNCE_THRESHOLD_MS) return;
      // Fire at most once per visit.
      if (sessionStorage.getItem("bounce_sent")) return;
      sessionStorage.setItem("bounce_sent", "1");

      const seconds = Math.round(elapsed / 1000);
      // Carry the referral so we still know where the bouncer came from.
      const referral = localStorage.getItem(REFERRAL_KEY);
      const payload = {
        webhookType: referral ? "referral_visit" : "regular_visit",
        event: referral
          ? `👋 Quick bounce from **${referral}** on ${window.location.pathname}`
          : `👋 Quick bounce on ${window.location.pathname}`,
        meta: {
          "🛤️ Path": pages.join(" → ") || window.location.pathname,
          "🔗 URL": window.location.href,
          "⏱️ Time on page": `${seconds}s`,
          "🕒 Time": new Date().toLocaleString(),
        },
      };

      // sendBeacon queues the request so it survives the page unload — a normal
      // fetch() gets cancelled when the page is tearing down. The Blob's JSON
      // type lets /api/track's req.json() parse it server-side.
      // 📖 Learn: navigator.sendBeacon — https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon
      navigator.sendBeacon(
        "/api/track",
        new Blob([JSON.stringify(payload)], { type: "application/json" }),
      );
    };

    window.addEventListener("pagehide", reportBounceOnExit);

    const sendVisit = () => {
      if (slashKeyHeld.current) return;
      if (window.location.hostname === "localhost") return;
      // test.<domain> is our staging subdomain — never report its traffic.
      if (window.location.hostname.startsWith("test.")) return;
      if (localStorage.getItem(TRACKING_OPT_OUT_KEY)) return;

      // Only track once per page load.
      if (hasTracked.current) return;
      hasTracked.current = true;

      const ua = navigator.userAgent;
      const isBot = /bot|crawler|spider/i.test(ua);
      const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
      const deviceType = isMobile ? "📱 Mobile" : "🖥️ Desktop";
      const platform = /iPhone|iPad/.test(ua)
        ? "iOS"
        : ua.includes("Android")
          ? "Android"
          : navigator.platform.includes("Mac")
            ? "macOS"
            : navigator.platform.includes("Win")
              ? "Windows"
              : navigator.platform.includes("Linux")
                ? "Linux"
                : "Unknown";

      // Accumulate visited paths within the session so Discord shows the full
      // journey (e.g. "/" → "/map"). sessionStorage clears when the tab closes.
      const currentPath = window.location.pathname || "/";
      const stored = sessionStorage.getItem("nav_path");
      const pathHistory: string[] = stored
        ? (JSON.parse(stored) as string[])
        : [];
      if (pathHistory[pathHistory.length - 1] !== currentPath) {
        pathHistory.push(currentPath);
      }
      sessionStorage.setItem("nav_path", JSON.stringify(pathHistory));
      const pathTrail = pathHistory.join(" → ");

      const eventLabel = isBot
        ? `🤖 Bot/crawler on ${currentPath}`
        : referralSource
          ? `👀 New visitor from **${referralSource}**`
          : rawParams
            ? `👀 New visitor — CUSTOM REFERRAL from **${describeCustomReferral(params)}**`
            : `👀 New visitor on ${currentPath}`;
      const webhookType =
        referralSource || rawParams ? "referral_visit" : "regular_visit";

      // trackVisit() calls our own /api/track — the webhook URL never leaves
      // the server, so it can't be scraped from the browser. IP + geolocation
      // are added server-side from Vercel's edge headers.
      trackVisit(
        eventLabel,
        {
          "🖥️ Device": `${deviceType} · ${platform}`,
          "🛤️ Path": pathTrail,
          "🔗 URL": fullUrl,
          "🕒 Time": new Date().toLocaleString(),
          ...(rawParams ? { "🔗 Params": `?${rawParams}` } : {}),
          ...(isBot ? { "🔍 UA": ua } : {}),
        },
        webhookType,
      );
    };

    sendVisit();

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("pagehide", reportBounceOnExit);
    };
  }, []);
}
