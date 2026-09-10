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
    firstPage.setQuickStart(key, "wallet");
    firstPage.dismissQuickStart(key);
    vi.resetModules();
    const nextPage = await import("./dashboard-quick-start");
    expect(nextPage.isQuickStartDismissed(key)).toBe(true);
    expect(nextPage.readQuickStart(key, "api-key")).toBe("wallet");
    nextPage.resumeQuickStart(key);
    expect(nextPage.isQuickStartDismissed(key)).toBe(false);
    expect(nextPage.readQuickStart(key, "api-key")).toBe("wallet");
  });

  it("does not let a stale tab reopen a guide dismissed in another tab", async () => {
    const guide = await import("./dashboard-quick-start");
    guide.setQuickStart(key, "wallet");
    window.localStorage.setItem(`${key}:dismissed`, "true");
    guide.setQuickStart(key, "faucet");
    expect(guide.isQuickStartDismissed(key)).toBe(true);
    expect(guide.readQuickStart(key)).toBe("faucet");
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
    guide.dismissQuickStart(key);
    expect(guide.isQuickStartDismissed(key)).toBe(true);
    guide.resumeQuickStart(key);
    expect(guide.isQuickStartDismissed(key)).toBe(false);
    expect(guide.readQuickStart(key)).toBe("api-key");
  });

  it("can restart previously saved completion when storage becomes read-only", async () => {
    const guide = await import("./dashboard-quick-start");
    guide.setQuickStart(key, "done");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    guide.dismissQuickStart(key);
    expect(guide.isQuickStartDismissed(key)).toBe(true);
    guide.resumeQuickStart(key);
    expect(guide.readQuickStart(key)).toBe("api-key");
    expect(guide.isQuickStartDismissed(key)).toBe(false);
  });

  it("updates a tab after another tab explicitly resumes the guide", async () => {
    const guide = await import("./dashboard-quick-start");
    guide.setQuickStart(key, "done");
    guide.dismissQuickStart(key);
    const unsubscribe = guide.subscribeQuickStart(() => {});
    window.localStorage.setItem(key, "api-key");
    window.localStorage.setItem(`${key}:dismissed`, "false");
    window.dispatchEvent(new StorageEvent("storage", { key }));
    window.dispatchEvent(new StorageEvent("storage", { key: `${key}:dismissed` }));
    expect(guide.readQuickStart(key)).toBe("api-key");
    expect(guide.isQuickStartDismissed(key)).toBe(false);
    unsubscribe();
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
