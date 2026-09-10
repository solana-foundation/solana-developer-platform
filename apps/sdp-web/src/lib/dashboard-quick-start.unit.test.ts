// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe("browser quick-start progress", () => {
  const key = "sdp:quick-start:v1:user:org";

  it("restores dismissal after a fresh page load", async () => {
    const firstPage = await import("./dashboard-quick-start");
    firstPage.setQuickStart(key, "done");
    vi.resetModules();
    const nextPage = await import("./dashboard-quick-start");
    expect(nextPage.readQuickStart(key, "api-key")).toBe("done");
  });

  it("does not let a stale tab reopen a guide dismissed in another tab", async () => {
    const guide = await import("./dashboard-quick-start");
    guide.setQuickStart(key, "wallet");
    window.localStorage.setItem(key, "done");
    guide.setQuickStart(key, "faucet");
    expect(window.localStorage.getItem(key)).toBe("done");
    expect(guide.readQuickStart(key)).toBe("done");
  });

  it("treats creating a wallet as completion even before the API-key step", async () => {
    const guide = await import("./dashboard-quick-start");
    guide.completeQuickStartStep(key, "wallet");
    expect(guide.readQuickStart(key)).toBe("done");
  });

  it("falls back to session progress when browser storage is unavailable", async () => {
    const guide = await import("./dashboard-quick-start");
    for (const method of ["getItem", "setItem"] as const) {
      vi.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error("Storage blocked");
      });
    }
    guide.setQuickStart(key, "done");
    expect(guide.readQuickStart(key)).toBe("done");
  });

  it("starts over after browser data is cleared and the page reloads", async () => {
    const firstPage = await import("./dashboard-quick-start");
    firstPage.setQuickStart(key, "done");
    window.localStorage.clear();
    vi.resetModules();
    const nextPage = await import("./dashboard-quick-start");
    expect(nextPage.readQuickStart(key, "api-key")).toBe("api-key");
  });
});
