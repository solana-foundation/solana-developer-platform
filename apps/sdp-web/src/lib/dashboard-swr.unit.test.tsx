// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
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
