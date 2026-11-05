// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { useEarnProviderAccess } from "./earn-provider-access";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const KAMINO_ACCESS = { entitled: true, configured: true, enabled: true };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useEarnProviderAccess", () => {
  it("is unknown until the organization's access answers, then its Earn entries", async () => {
    const answer = Promise.withResolvers<Response>();
    stubDashboardFetch(() => answer.promise);
    const { result } = renderHook(useEarnProviderAccess, { wrapper: DashboardReadsProvider });

    expect(result.current.providerAccess).toBeUndefined();
    await act(async () =>
      answer.resolve(
        dashboardDataResponse(200, {
          providers: { ramps: {}, earn: { kamino: KAMINO_ACCESS } },
        })
      )
    );

    await waitFor(() => expect(result.current.providerAccess).toEqual({ kamino: KAMINO_ACCESS }));
  });

  it("is no access when the read fails", async () => {
    stubDashboardFetch(() => dashboardErrorResponse(503, "Provider access unavailable."));

    const { result } = renderHook(useEarnProviderAccess, { wrapper: DashboardReadsProvider });

    await waitFor(() => expect(result.current.providerAccess).toBeNull());
  });
});
