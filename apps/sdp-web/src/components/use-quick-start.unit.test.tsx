// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QuickStartStatus } from "@/lib/dashboard-quick-start.redesign";

const STATUS: QuickStartStatus = {
  rpcProvider: null,
  custodyProvider: "privy",
  apiKeyCount: 1,
  lastCallAt: null,
} as QuickStartStatus;

const mocks = vi.hoisted(() => ({
  workspace: {
    initialQuickStartStatus: null as unknown,
    sdpEnvironment: "sandbox",
    dashboardAccess: { capabilities: { canManageApiKeys: true } },
    dashboardCacheScope: { userId: "user_q", orgId: "org_q" },
    selectedProjectId: "prj_q" as string | null,
  },
  fetch: vi.fn(),
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => mocks.workspace,
  useOptionalDashboardWorkspace: () => mocks.workspace,
}));
vi.mock("@/lib/dashboard-fetch", () => ({ dashboardFetch: mocks.fetch }));
vi.mock("@/lib/dashboard-swr", async () => {
  const { default: useSWR } = await import("swr");
  return {
    usePersistedDashboardSWR: (key: string | null, fetcher: () => Promise<unknown>, options = {}) =>
      useSWR(key, fetcher, options),
  };
});

const { useQuickStart } = await import("./use-quick-start");
const { dismissQuickStart, invalidateQuickStartStatus, quickStartKey } = await import(
  "@/lib/dashboard-quick-start.redesign"
);

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

type Answer = { ok: true; data: unknown } | { ok: false; error: string };
function answer(routes: { status?: Answer; probe?: Answer }) {
  mocks.fetch.mockImplementation(async (path: string) => {
    const reply = path.includes("rpc-test") ? routes.probe : routes.status;
    return reply ?? { ok: false, error: "unrouted", status: 500, body: null };
  });
}
const okStatus = (status: Partial<QuickStartStatus> = {}): Answer => ({
  ok: true,
  data: { data: { ...STATUS, ...status } },
});
const probe = (ok: boolean, provider = "default"): Answer => ({
  ok: true,
  data: { data: { provider: { id: provider }, upstream: { ok, status: ok ? 200 : 502 } } },
});

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
  mocks.fetch.mockReset();
});

describe("useQuickStart", () => {
  it("shows the guide while the RPC probe settles, then marks the step done", async () => {
    answer({ status: okStatus(), probe: probe(true) });
    const { result } = renderHook(() => useQuickStart(), { wrapper });

    expect(result.current.eligible).toBe(true);
    expect(result.current.storageKey).toBe(quickStartKey(mocks.workspace.dashboardCacheScope));
    await waitFor(() => expect(result.current.probe?.outcome).toBe("ok"));
    expect(result.current.steps.map((step) => step.state)).toEqual(["done", "done", "pending"]);
    expect(result.current.visible).toBe(true);
    expect(result.current.complete).toBe(false);
  });

  it("reports a node that answered badly as failing, and an unreachable relay as pending", async () => {
    answer({ status: okStatus(), probe: probe(false) });
    const failing = renderHook(() => useQuickStart(), { wrapper });
    await waitFor(() => expect(failing.result.current.probe?.outcome).toBe("upstream_error"));
    expect(failing.result.current.probe?.status).toBe(502);
    expect(failing.result.current.steps[0]?.state).toBe("failing");
    failing.unmount();

    answer({ status: okStatus(), probe: { ok: false, error: "quota" } });
    const unreachable = renderHook(() => useQuickStart(), { wrapper });
    await waitFor(() => expect(unreachable.result.current.probe?.outcome).toBe("unreachable"));
    expect(unreachable.result.current.probe?.provider).toBeNull();
    expect(unreachable.result.current.steps[0]?.state).toBe("pending");
  });

  it("hides itself once every step is done", async () => {
    mocks.workspace.initialQuickStartStatus = { ...STATUS, lastCallAt: "2026-09-25T10:00:00Z" };
    answer({ status: okStatus({ lastCallAt: "2026-09-25T10:00:00Z" }), probe: probe(true) });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.visible).toBe(false);
  });

  it("probes the saved provider and re-reads the status when a flow marks it stale", async () => {
    mocks.workspace.initialQuickStartStatus = { ...STATUS, rpcProvider: "helius" };
    answer({ status: okStatus({ rpcProvider: "helius" }), probe: probe(true, "helius") });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    await waitFor(() => expect(result.current.probe?.provider).toBe("helius"));
    // The status arrives with the page; the guide re-reads it only when told it changed.
    expect(mocks.fetch).not.toHaveBeenCalledWith("/api/dashboard/quick-start");

    const statusReads = () =>
      mocks.fetch.mock.calls.filter(([path]) => path === "/api/dashboard/quick-start").length;
    const before = statusReads();
    act(() => invalidateQuickStartStatus());
    await waitFor(() => expect(statusReads()).toBeGreaterThan(before));
  });

  it("probes again after a provider switch instead of reusing the previous provider's answer", async () => {
    answer({ status: okStatus(), probe: probe(true, "default") });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    await waitFor(() => expect(result.current.probe?.provider).toBe("default"));

    // The switch to a provider whose node fails: the old "ok" must not carry over.
    answer({ status: okStatus({ rpcProvider: "helius" }), probe: probe(false, "helius") });
    act(() => invalidateQuickStartStatus());
    await waitFor(() => expect(result.current.probe?.provider).toBe("helius"));
    expect(result.current.steps[0]?.state).toBe("failing");
    const probes = mocks.fetch.mock.calls.filter(([path]) => String(path).includes("rpc-test"));
    expect(probes).toHaveLength(2);
  });

  it("keeps the last known status when a re-read fails", async () => {
    answer({ status: { ok: false, error: "down" }, probe: probe(true) });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    await waitFor(() => expect(result.current.probe?.outcome).toBe("ok"));
    act(() => invalidateQuickStartStatus());
    await waitFor(() =>
      expect(mocks.fetch.mock.calls.some(([path]) => path === "/api/dashboard/quick-start")).toBe(
        true
      )
    );
    expect(result.current.status).toEqual(STATUS);

    answer({ status: { ok: true, data: { data: null } }, probe: probe(true) });
    act(() => invalidateQuickStartStatus());
    await waitFor(() => expect(result.current.status).toEqual(STATUS));
  });

  it("stops reading once dismissed", async () => {
    answer({ status: okStatus(), probe: probe(true) });
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
    ["no server status", (w: typeof mocks.workspace) => (w.initialQuickStartStatus = null)],
  ])("is not offered with %s", (_, change) => {
    change(mocks.workspace);
    answer({ status: okStatus(), probe: probe(true) });
    const { result } = renderHook(() => useQuickStart(), { wrapper });
    expect(result.current.eligible).toBe(false);
    expect(result.current.visible).toBe(false);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
