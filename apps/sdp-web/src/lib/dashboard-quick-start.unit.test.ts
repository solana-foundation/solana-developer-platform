// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickStartStatus, RpcProbeResult } from "./dashboard-quick-start";

beforeEach(() => {
  vi.resetModules();
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

const status: QuickStartStatus = {
  rpcProvider: null,
  custodyProvider: null,
  apiKeyCount: 0,
  lastCallAt: null,
};
const probe = (outcome: RpcProbeResult["outcome"]): RpcProbeResult => ({
  outcome,
  status: outcome === "unreachable" ? null : outcome === "ok" ? 200 : 503,
  provider: outcome === "unreachable" ? null : "default",
  checkedAt: "2026-09-25T10:00:00.000Z",
});

describe("resolveQuickStartSteps", () => {
  it("reads the prototype's state: probe answered, custody skipped, no call yet", async () => {
    const { resolveQuickStartSteps, countSettledQuickStartSteps, isQuickStartComplete } =
      await import("./dashboard-quick-start");
    const steps = resolveQuickStartSteps({
      status,
      probe: probe("ok"),
      skipped: { custody: "2026-09-25T09:00:00.000Z" },
    });
    expect(steps).toEqual([
      { id: "rpc", state: "done" },
      { id: "custody", state: "skipped" },
      { id: "first-call", state: "pending" },
    ]);
    expect(countSettledQuickStartSteps(steps)).toBe(2);
    expect(isQuickStartComplete(steps)).toBe(false);
  });

  it("keeps the RPC step checking until the first probe answers", async () => {
    const { resolveQuickStartSteps } = await import("./dashboard-quick-start");
    expect(resolveQuickStartSteps({ status, probe: null, skipped: {} })[0]?.state).toBe("checking");
  });

  it("fails the RPC step only when the node answered badly", async () => {
    const { resolveQuickStartSteps } = await import("./dashboard-quick-start");
    const rpc = (outcome: RpcProbeResult["outcome"]) =>
      resolveQuickStartSteps({ status, probe: probe(outcome), skipped: {} })[0]?.state;
    expect(rpc("upstream_error")).toBe("failing");
    // Our own request failing (quota, network) is not the node's fault.
    expect(rpc("unreachable")).toBe("pending");
  });

  it("lets a connected provider win over an earlier skip", async () => {
    const { resolveQuickStartSteps } = await import("./dashboard-quick-start");
    const steps = resolveQuickStartSteps({
      status: { ...status, custodyProvider: "privy" },
      probe: probe("ok"),
      skipped: { custody: "2026-09-20T09:00:00.000Z" },
    });
    expect(steps[1]).toEqual({ id: "custody", state: "done" });
  });

  it("completes only when every signal is in, not when steps are skipped", async () => {
    const { resolveQuickStartSteps, isQuickStartComplete } = await import(
      "./dashboard-quick-start"
    );
    const skipped = resolveQuickStartSteps({
      status: { ...status, lastCallAt: "2026-09-25T09:30:00.000Z", apiKeyCount: 1 },
      probe: probe("ok"),
      skipped: { custody: "2026-09-25T09:00:00.000Z" },
    });
    expect(isQuickStartComplete(skipped)).toBe(false);
    const done = resolveQuickStartSteps({
      status: {
        ...status,
        custodyProvider: "privy",
        lastCallAt: "2026-09-25T09:30:00.000Z",
        apiKeyCount: 1,
      },
      probe: probe("ok"),
      skipped: {},
    });
    expect(isQuickStartComplete(done)).toBe(true);
  });
});

describe("quick start preferences", () => {
  const key = "sdp:quick-start:v2:user:org";

  it("persists dismissal, folding and skips across a fresh page load", async () => {
    const firstPage = await import("./dashboard-quick-start");
    firstPage.skipQuickStartStep(key, "custody", new Date("2026-09-25T09:00:00.000Z"));
    firstPage.setQuickStartCollapsed(key, "sidebar", true);
    firstPage.dismissQuickStart(key);
    vi.resetModules();
    const nextPage = await import("./dashboard-quick-start");
    expect(nextPage.readQuickStartPrefs(key)).toEqual({
      dismissed: true,
      collapsed: false,
      sidebarCollapsed: true,
      skipped: { custody: "2026-09-25T09:00:00.000Z" },
    });
    nextPage.resumeQuickStart(key);
    expect(nextPage.readQuickStartPrefs(key)).toMatchObject({
      dismissed: false,
      sidebarCollapsed: false,
      skipped: { custody: "2026-09-25T09:00:00.000Z" },
    });
  });

  it("returns the same snapshot until the stored value changes", async () => {
    const guide = await import("./dashboard-quick-start");
    const first = guide.readQuickStartPrefs(key);
    expect(guide.readQuickStartPrefs(key)).toBe(first);
    guide.setQuickStartCollapsed(key, "overview", true);
    expect(guide.readQuickStartPrefs(key)).not.toBe(first);
  });

  it("ignores a corrupt stored value", async () => {
    window.localStorage.setItem(key, "{not json");
    const guide = await import("./dashboard-quick-start");
    expect(guide.readQuickStartPrefs(key)).toBe(guide.EMPTY_QUICK_START_PREFS);
  });

  it("keeps working for the session when storage is blocked", async () => {
    const guide = await import("./dashboard-quick-start");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    guide.dismissQuickStart(key);
    expect(guide.readQuickStartPrefs(key).dismissed).toBe(true);
  });

  it("notifies subscribers when another tab changes the guide", async () => {
    const guide = await import("./dashboard-quick-start");
    const onChange = vi.fn();
    const unsubscribe = guide.subscribeQuickStart(onChange);
    window.localStorage.setItem(key, JSON.stringify({ dismissed: true }));
    window.dispatchEvent(new StorageEvent("storage", { key }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(guide.readQuickStartPrefs(key).dismissed).toBe(true);
    unsubscribe();
  });

  it("tells a mounted guide its status is stale", async () => {
    const guide = await import("./dashboard-quick-start");
    const onStale = vi.fn();
    const unsubscribe = guide.subscribeQuickStartStatusStale(onStale);
    guide.invalidateQuickStartStatus();
    expect(onStale).toHaveBeenCalledTimes(1);
    unsubscribe();
    guide.invalidateQuickStartStatus();
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});
