// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { SANDBOX_PROJECT } from "@/test/projects";
import { PRIVATE_CHANNELS_EVENTS_PAGE_SIZE } from "./private-channels-query-key";
import { usePrivateChannelBalances, usePrivateChannelEvents } from "./private-channels-reads";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const OWNER_A = "OwnerA111111111111111111111111111111111111";
const OWNER_B = "OwnerB111111111111111111111111111111111111";
const BALANCE_A = {
  mint: "Mint111111111111111111111111111111111111111",
  amount: "12500000",
  decimals: 6,
  uiAmount: "12.5",
};

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usePrivateChannelBalances", () => {
  it("reads each owner once under one entry and leaves out an owner whose read fails", async () => {
    const fetchMock = stubDashboardFetch(({ path }) =>
      path === `/api/dashboard/private-channels/balance?owner=${OWNER_A}`
        ? Response.json({ data: BALANCE_A })
        : dashboardErrorResponse(503, "Gateway unavailable")
    );

    const { result } = renderHook(
      () => ({
        listed: usePrivateChannelBalances([OWNER_B, OWNER_A]),
        reordered: usePrivateChannelBalances([OWNER_A, OWNER_B]),
      }),
      { wrapper: DashboardReadsProvider }
    );

    await waitFor(() => expect(result.current.listed.data).toEqual({ [OWNER_A]: BALANCE_A }));
    expect(result.current.reordered.data).toEqual({ [OWNER_A]: BALANCE_A });
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      `/api/dashboard/private-channels/balance?owner=${OWNER_A}`,
      `/api/dashboard/private-channels/balance?owner=${OWNER_B}`,
    ]);
  });
});

describe("usePrivateChannelEvents", () => {
  it("keeps a row whose family, type and status the dashboard does not know", async () => {
    const page = {
      events: [
        {
          id: "pce_test_unknown",
          organizationId: "org_test",
          projectId: SANDBOX_PROJECT.id,
          instanceId: "pci_test",
          channelId: null,
          sdpUserId: null,
          family: "settlement",
          type: "settlement.batch_rolled",
          status: "queued",
          payload: {},
          occurredAt: "2026-09-16T00:00:00.000Z",
          createdAt: "2026-09-16T00:00:00.000Z",
        },
      ],
      hasMore: false,
      nextCursor: null,
    };
    const fetchMock = stubDashboardFetch(() => Response.json({ data: page }));

    const { result } = renderHook(() => usePrivateChannelEvents(), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.data).toEqual(page));
    expect(result.current.error).toBeUndefined();
    expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([
      `/api/dashboard/private-channels/events?limit=${PRIVATE_CHANNELS_EVENTS_PAGE_SIZE}`,
    ]);
  });
});
