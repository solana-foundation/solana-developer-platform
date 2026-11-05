// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDashboardCacheScopeKey } from "@/lib/dashboard-cache-scope";
import { DASHBOARD_CACHE_STORAGE_PREFIX } from "@/lib/dashboard-snapshot-storage";
import { usePersistedDashboardSWR } from "./dashboard-swr";

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useDashboardWorkspace: () => ({
    dashboardCacheScope: { userId: "user", orgId: "org" },
    selectedProjectId: "project",
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("optional dashboard cache storage", () => {
  it.each(["localStorage", "sessionStorage"] as const)(
    "loads fresh data when %s access is denied",
    async (storage) => {
      vi.spyOn(window, storage, "get").mockImplementation(() => {
        throw new DOMException("Blocked", "SecurityError");
      });
      const { result } = renderHook(
        () =>
          usePersistedDashboardSWR(
            "balance",
            async () => ({ amount: 12 }),
            {},
            {
              key: "balance",
              ttlMs: 30000,
              storage: storage === "localStorage" ? "local" : "session",
            }
          ),
        { wrapper }
      );
      await waitFor(() => expect(result.current.data).toEqual({ amount: 12 }));
    }
  );

  it("loads fresh data when a storage read throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Read failed");
    });
    const { result } = renderHook(
      () => usePersistedDashboardSWR("read", async () => 17, {}, { key: "read", ttlMs: 30000 }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.data).toBe(17));
  });

  it("ignores a corrupt entry even when removing it fails", async () => {
    localStorage.setItem("sdp.dashboard.cache.user:org:project.corrupt", "invalid-json");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("Remove failed");
    });
    const { result } = renderHook(
      () =>
        usePersistedDashboardSWR("corrupt", async () => 21, {}, { key: "corrupt", ttlMs: 30000 }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.data).toBe(21));
  });
});

function StoredSnapshot() {
  const { data } = usePersistedDashboardSWR(
    "stored",
    () => new Promise<string>(() => {}),
    {},
    { key: "stored", ttlMs: 30000 }
  );
  return <output>{data}</output>;
}

describe("persisted dashboard snapshot hydration", () => {
  it("hydrates to the server markup, then shows the stored snapshot", async () => {
    const ui = wrapper({ children: <StoredSnapshot /> });
    const container = document.createElement("div");
    container.innerHTML = renderToString(ui);
    const scopeKey = getDashboardCacheScopeKey(
      { userId: "user", orgId: "org" },
      { projectId: "project" }
    );
    localStorage.setItem(
      `${DASHBOARD_CACHE_STORAGE_PREFIX}.${scopeKey}.stored`,
      JSON.stringify({ expiresAt: Date.now() + 30000, value: "cached", version: 1 })
    );
    const onRecoverableError = vi.fn();
    const root = await act(async () => hydrateRoot(container, ui, { onRecoverableError }));
    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(container.textContent).toBe("cached");
    act(() => root.unmount());
  });
});
