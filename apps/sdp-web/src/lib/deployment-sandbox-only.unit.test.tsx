// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as dashboardFetchModule from "@/lib/dashboard-fetch";
import { useDeploymentSandboxOnly } from "./deployment-sandbox-only";

function freshCache({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ provider: () => new Map() }}>{children}</SWRConfig>;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useDeploymentSandboxOnly", () => {
  it("answers true once the organization's mainnet access says the deployment is sandbox-only", async () => {
    const read = vi
      .spyOn(dashboardFetchModule, "dashboardFetch")
      .mockResolvedValue({ ok: true, data: { data: { sandboxOnly: true } } } as never);
    const { result } = renderHook(() => useDeploymentSandboxOnly("org_sdp"), {
      wrapper: freshCache,
    });

    await waitFor(() => expect(result.current).toBe(true));
    expect(read).toHaveBeenCalledExactlyOnceWith(
      "/api/dashboard/organizations/org_sdp/mainnet-access"
    );
  });

  it("answers false when the API omits the field or the read fails", async () => {
    vi.spyOn(dashboardFetchModule, "dashboardFetch").mockResolvedValue({
      ok: true,
      data: { data: {} },
    } as never);
    const omitted = renderHook(() => useDeploymentSandboxOnly("org_sdp"), { wrapper: freshCache });
    await waitFor(() => expect(dashboardFetchModule.dashboardFetch).toHaveBeenCalled());
    expect(omitted.result.current).toBe(false);

    vi.spyOn(dashboardFetchModule, "dashboardFetch").mockResolvedValue({
      ok: false,
      error: "unavailable",
    } as never);
    const failed = renderHook(() => useDeploymentSandboxOnly("org_other"), {
      wrapper: freshCache,
    });
    await waitFor(() => expect(dashboardFetchModule.dashboardFetch).toHaveBeenCalled());
    expect(failed.result.current).toBe(false);
  });

  it("reads nothing without an organization", () => {
    const read = vi.spyOn(dashboardFetchModule, "dashboardFetch");
    const { result } = renderHook(() => useDeploymentSandboxOnly(null), { wrapper: freshCache });
    expect(result.current).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});
