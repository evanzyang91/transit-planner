"use client";

// 📖 Learn: "use client" marks this as a Client Component in Next.js App Router.
// It runs in the browser, so we can use useState/useEffect and access `window`.

import { useEffect, useState } from "react";
import {
  rememberMobileWarningDismissed,
  shouldShowMobileWarning,
  wasMobileWarningDismissed,
} from "./mobile-warning";

// Passed to the helpers as a function so that reading `window.sessionStorage`
// (which can throw when storage is blocked) happens inside their try block.
const getSessionStorage = () => window.sessionStorage;

export default function MobileWarningModal() {
  // Start hidden — we don't know the screen size until the browser runs this code.
  const [show, setShow] = useState(false);

  useEffect(() => {
    // Narrow screen (below Tailwind's `md`, 768px) AND not already dismissed
    // in this tab → show. The rules live in ./mobile-warning so they're tested.
    const dismissedThisSession = wasMobileWarningDismissed(getSessionStorage);
    if (shouldShowMobileWarning(window.innerWidth, dismissedThisSession)) {
      setShow(true);
    }
  }, []); // Empty deps = run once on mount

  function handleContinueAnyway() {
    // Remember the choice for this browser-tab session, so later page loads
    // (a refresh, a hard navigation) don't cover the page with the overlay again.
    rememberMobileWarningDismissed(getSessionStorage);
    setShow(false);
  }

  if (!show) return null;

  return (
    // Full-screen dark overlay
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="mx-6 max-w-sm rounded-2xl bg-white p-6 text-center shadow-2xl dark:bg-zinc-900">
        {/* Phone icon */}
        <div className="mb-4 flex justify-center">
          <svg
            className="h-12 w-12 text-blue-500"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 20.25h3"
            />
          </svg>
        </div>

        <h2 className="mb-2 text-lg font-bold text-zinc-900 dark:text-white">
          Best on Desktop
        </h2>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Transit planner works best on desktop. Mobile app coming soon.
        </p>

        <button
          onClick={handleContinueAnyway}
          className="w-full rounded-xl bg-blue-500 py-2.5 text-sm font-semibold text-white hover:bg-blue-600 active:bg-blue-700"
        >
          Continue anyway
        </button>
      </div>
    </div>
  );
}
