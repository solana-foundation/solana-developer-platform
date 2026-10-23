// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dismissQuickStart,
  invalidateQuickStartStatus,
  type QuickStartStatus,
  quickStartKey,
} from "@/lib/dashboard-quick-start.redesign";

const STATUS: QuickStartStatus = {
  custodyProvider: "privy",
  apiKeyCount: 1,
  lastCallAt: null,
};
const QUICK_START_PATH = "/api/dashboard/quick-start";

const mocks = vi.hoisted(() => ({
  workspace: {
    initialQuickStartStatus: null as QuickStartStatus | null,
    sdpEnvironment: "sandbox",
    dashboardAccess: { capabilities: { canManageApiKeys: true } },
    dashboardCacheScope: { userId: "user_q", orgId: "org_q" },
    selectedProjectId: "prj_q" as string | null,
  },
}));

// The viewer's workspace is one ambient input per render; the fetch and SWR layers are real.
vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => mocks.workspace,
  useOptionalDashboardWorkspace: () => mocks.workspace,
}));

const { useQuickStart } = await import("./use-quick-start");

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

/** What the quick-start route answers: a status, "unknown" (`data: null`), or a failure. */
type Answer = { status: QuickStartStatus | null } | { failure: true };

function answer(reply: Answer) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      "failure" in reply
        ? new Response("{}", { status: 500 })
        : Response.json({ data: reply.status })
    );
}

const statusReads = (spy: ReturnType<typeof answer>) =>
  spy.mock.calls.filter(([path]) => path === QUICK_START_PATH).length;

let orgSequence = 0;
beforeEach(() => {
  window.localStorage.clear();
  mocks.workspace.initialQuickStartStatus = { ...STATUS };
  mocks.workspace.sdpEnvironment = "sandbox";
  mocks.workspace.dashboardAccess.capabilities.canManageApiKeys = true;
  mocks.workspace.dashboardCacheScope = { userId: "user_q", orgId: `org_q_${++orgSequence}` };
  mocks.workspace.selectedProjectId = "prj_q";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useQuickStart", () => {
  it("shows the guide with the server's status, custody done and the first call pending", () => {
    answer({ status: STATUS });
    const { result } = renderHook(() => useQuickStart(), { wrapper });

    expect(result.current.eligible).toBe(true);
    expect(result.current.storageKey).toBe(quickStartKey(mocks.workspace.dashboardCacheScope));
    expect(result.current.steps.map((step) => step.state)).toEqual(["done", "pending"]);
    expect(result.current.visible).toBe(true);
    expect(result.current.complete).toBe(false);
  });

  it("hides itself once every step is done", () => {
    const finished = { ...STATUS, lastCallAt: "2026-09-25T10:00:00Z" };
    mocks.workspace.initialQuickStartStatus = finished;
    answer({ status: finished });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    expect(result.current.complete).toBe(true);
    expect(result.current.visible).toBe(false);
  });

  it("polls every two minutes until the read that completes the guide", async () => {
    vi.useFakeTimers();
    const spy = answer({ status: { ...STATUS, lastCallAt: "2026-09-25T10:00:00Z" } });
    const { result } = renderHook(() => useQuickStart(), { wrapper });

    await vi.advanceTimersByTimeAsync(119_000);
    expect(statusReads(spy)).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statusReads(spy)).toBe(1);
    expect(result.current.complete).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(statusReads(spy)).toBe(1);
  });

  it("never polls a guide the page loaded complete", async () => {
    vi.useFakeTimers();
    const finished = { ...STATUS, lastCallAt: "2026-09-25T10:00:00Z" };
    mocks.workspace.initialQuickStartStatus = finished;
    const spy = answer({ status: finished });
    renderHook(() => useQuickStart(), { wrapper });

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(statusReads(spy)).toBe(0);
  });

  it("re-reads the status when a flow marks it stale", async () => {
    const spy = answer({ status: STATUS });
    renderHook(() => useQuickStart(), { wrapper });
    // The status arrives with the page; the guide re-reads it only when told it changed.
    expect(statusReads(spy)).toBe(0);

    act(() => invalidateQuickStartStatus());
    await waitFor(() => expect(statusReads(spy)).toBeGreaterThan(0));
  });

  it("keeps the last known status when a re-read fails", async () => {
    const spy = answer({ failure: true });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    act(() => invalidateQuickStartStatus());
    await waitFor(() => expect(statusReads(spy)).toBeGreaterThan(0));
    expect(result.current.status).toEqual(STATUS);

    answer({ status: null });
    act(() => invalidateQuickStartStatus());
    await waitFor(() => expect(result.current.status).toEqual(STATUS));
  });

  it("recovers when the server's first read failed, once the status can be read again", async () => {
    mocks.workspace.initialQuickStartStatus = null;
    answer({ status: STATUS });
    const { result } = renderHook(() => useQuickStart(), { wrapper });

    expect(result.current.eligible).toBe(true);
    await waitFor(() => expect(result.current.status).toEqual(STATUS));
    expect(result.current.visible).toBe(true);
  });

  it("stops reading once dismissed", () => {
    answer({ status: STATUS });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    act(() => dismissQuickStart(result.current.storageKey));
    expect(result.current.prefs.dismissed).toBe(true);
    expect(result.current.visible).toBe(false);
  });

  it.each([
    ["production", (w: typeof mocks.workspace) => (w.sdpEnvironment = "production")],
    [
      "no key permission",
      (w: typeof mocks.workspace) => (w.dashboardAccess.capabilities.canManageApiKeys = false),
    ],
    ["no organization", (w: typeof mocks.workspace) => (w.dashboardCacheScope.orgId = "")],
    ["no project", (w: typeof mocks.workspace) => (w.selectedProjectId = null)],
  ])("is not offered with %s", (_, change) => {
    change(mocks.workspace);
    const spy = answer({ status: STATUS });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    expect(result.current.eligible).toBe(false);
    expect(result.current.visible).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
