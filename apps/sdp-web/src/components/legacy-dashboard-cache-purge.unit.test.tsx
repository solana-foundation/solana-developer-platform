// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LegacyDashboardCachePurge } from "./legacy-dashboard-cache-purge";

const legacyKeys = [
  "sdp.dashboard.cache.user_a:org_a:project_a.wallets",
  "sdp.dashboard.cache.user_a:org_a:project_a.payments",
];

beforeEach(() => {
  for (const storage of [localStorage, sessionStorage]) {
    for (const legacyKey of legacyKeys) storage.setItem(legacyKey, "private data");
    storage.setItem("sdp-theme", "dark");
    storage.setItem("sdp:dashboard:mutation:idempotency:v1:user:org", "pending recovery key");
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe("legacy dashboard cache purge", () => {
  it("removes every legacy cache key from both stores and keeps unrelated keys", () => {
    render(<LegacyDashboardCachePurge />);
    for (const storage of [localStorage, sessionStorage]) {
      expect(legacyKeys.map((legacyKey) => storage.getItem(legacyKey))).toEqual([null, null]);
      expect(storage.getItem("sdp-theme")).toBe("dark");
      expect(storage.getItem("sdp:dashboard:mutation:idempotency:v1:user:org")).toBe(
        "pending recovery key"
      );
    }
  });

  it("still purges session storage when access to local storage is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    expect(() => render(<LegacyDashboardCachePurge />)).not.toThrow();
    expect(legacyKeys.map((legacyKey) => sessionStorage.getItem(legacyKey))).toEqual([null, null]);
  });
});
