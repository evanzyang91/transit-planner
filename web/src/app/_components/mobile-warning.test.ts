import { describe, expect, it } from "vitest";

import {
  MOBILE_WARNING_BREAKPOINT_PX,
  MOBILE_WARNING_DISMISSED_KEY,
  type SessionStore,
  rememberMobileWarningDismissed,
  shouldShowMobileWarning,
  wasMobileWarningDismissed,
} from "./mobile-warning";

/** A Map-backed stand-in for window.sessionStorage. */
function fakeStore(): SessionStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/** Simulates a browser that blocks site storage (access itself throws). */
function blockedStore(): SessionStore {
  throw new DOMException("The operation is insecure.", "SecurityError");
}

describe("shouldShowMobileWarning", () => {
  it("shows on a phone-sized viewport the first time", () => {
    expect(shouldShowMobileWarning(390, false)).toBe(true);
  });

  it("uses the md breakpoint: 767px shows, 768px does not", () => {
    expect(shouldShowMobileWarning(MOBILE_WARNING_BREAKPOINT_PX - 1, false)).toBe(true);
    expect(shouldShowMobileWarning(MOBILE_WARNING_BREAKPOINT_PX, false)).toBe(false);
  });

  it("never shows on a desktop-width viewport", () => {
    expect(shouldShowMobileWarning(1440, false)).toBe(false);
  });

  it("stays hidden after 'Continue anyway', even on a narrow window", () => {
    expect(shouldShowMobileWarning(390, true)).toBe(false);
  });
});

describe("session memory of 'Continue anyway'", () => {
  it("is not dismissed in a fresh session", () => {
    const store = fakeStore();
    expect(wasMobileWarningDismissed(() => store)).toBe(false);
  });

  it("remembers the dismissal for later page loads in the same tab", () => {
    const store = fakeStore();
    rememberMobileWarningDismissed(() => store);

    expect(store.values.get(MOBILE_WARNING_DISMISSED_KEY)).toBe("1");
    expect(wasMobileWarningDismissed(() => store)).toBe(true);
  });

  it("ignores unexpected stored values", () => {
    const store = fakeStore();
    store.setItem(MOBILE_WARNING_DISMISSED_KEY, "yes");
    expect(wasMobileWarningDismissed(() => store)).toBe(false);
  });

  it("falls back to 'not dismissed' when storage is blocked", () => {
    expect(wasMobileWarningDismissed(blockedStore)).toBe(false);
  });

  it("does not throw when storage is blocked or full", () => {
    const fullStore: SessionStore = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      },
    };
    expect(() => rememberMobileWarningDismissed(blockedStore)).not.toThrow();
    expect(() => rememberMobileWarningDismissed(() => fullStore)).not.toThrow();
  });
});
