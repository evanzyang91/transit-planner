// Pure decision logic for <MobileWarningModal />, kept out of the component so
// it can be unit-tested without a browser (vitest runs in plain Node here).
//
// Behaviour: the "Best on Desktop" overlay appears on narrow screens, and once
// someone clicks "Continue anyway" it stays dismissed for the rest of the
// browser-tab session. Before this, it came back on every page load, which also
// blocked the "Start Mapping" button in a narrow (split-screen) desktop window.

/** Below this viewport width (Tailwind's `md` breakpoint) we show the warning. */
export const MOBILE_WARNING_BREAKPOINT_PX = 768;

/** sessionStorage key that remembers "Continue anyway" for this tab. */
export const MOBILE_WARNING_DISMISSED_KEY = "mobile_warning_dismissed";

/**
 * The two Web Storage methods we use. Typing it this narrowly lets the tests
 * pass a tiny fake object instead of a real browser `Storage`.
 */
export type SessionStore = Pick<Storage, "getItem" | "setItem">;

export function shouldShowMobileWarning(
  viewportWidthPx: number,
  dismissedThisSession: boolean,
): boolean {
  if (dismissedThisSession) return false;
  return viewportWidthPx < MOBILE_WARNING_BREAKPOINT_PX;
}

// Both helpers take a *function* that returns the store, rather than the store
// itself. That's because merely reading `window.sessionStorage` can throw a
// SecurityError when the browser blocks site storage, so the read has to
// happen inside the try block.
// 📖 Learn: sessionStorage — https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage

export function wasMobileWarningDismissed(getStore: () => SessionStore): boolean {
  try {
    return getStore().getItem(MOBILE_WARNING_DISMISSED_KEY) === "1";
  } catch {
    // Storage unavailable: behave like before and treat it as not dismissed.
    return false;
  }
}

export function rememberMobileWarningDismissed(getStore: () => SessionStore): void {
  try {
    getStore().setItem(MOBILE_WARNING_DISMISSED_KEY, "1");
  } catch {
    // Storage unavailable or full: the dismissal then lasts only until the next
    // page load (the old behaviour). That's acceptable, so we just carry on.
  }
}
