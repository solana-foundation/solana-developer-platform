// @vitest-environment jsdom

import { WELL_KNOWN_TOKENS } from "@sdp/types/well-known-tokens";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { type State, SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardDataResponse,
  dashboardErrorResponse,
  type SentDashboardRequest,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { useWalletActivityWindow } from "./use-wallet-activity-window";

const ACTIVITY_PATH = "/api/dashboard/wallets/wallet_one/activity";

function payload(count: number, activityNotice: string | null = null) {
  return {
    activityRows: Array.from({ length: count }, (_, index) => ({
      id: `payment-xfr_${index}`,
      sourceKind: "payments",
      operationLabel: "Outgoing",
      status: "finalized",
      signature: null,
      token: WELL_KNOWN_TOKENS.USDC.symbol,
      amount: "1.00",
      createdAt: "2026-09-11T00:00:00.000Z",
    })),
    activityError: null,
    activityNotice,
    hasMore: true,
  };
}

/** The window a request asked for; the route reads 20 rows when the page names none. */
function windowOf(request: SentDashboardRequest): number {
  const url = new URL(request.path, "https://dashboard.test");
  expect(url.pathname).toBe(ACTIVITY_PATH);
  const limit = url.searchParams.get("limit");
  return limit === null ? 20 : Number(limit);
}

/** Answers each activity read: `widerAnswer` decides every window past the first. */
function stubActivityFeed(widerAnswer: (window: number) => Response) {
  return stubDashboardFetch((request) => {
    const window = windowOf(request);
    return window === 20 ? dashboardDataResponse(200, payload(20)) : widerAnswer(window);
  });
}

function windowsRequested(fetchMock: ReturnType<typeof stubDashboardFetch>): number[] {
  return sentDashboardRequests(fetchMock).map(windowOf);
}

/** Renders over `cache`, so a test can revisit the wallet with what an earlier visit left. */
function CachedSWR({ cache, children }: { cache: Map<string, State>; children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => cache, shouldRetryOnError: false, dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

/** Renders the hook for wallet_one over `cache`. */
function renderWindow(cache: Map<string, State>) {
  return renderHook(() => useWalletActivityWindow("wallet_one"), {
    wrapper: ({ children }) => <CachedSWR cache={cache}>{children}</CachedSWR>,
  });
}

beforeEach(() => {
  setWindowPathname(`/dashboard/${SANDBOX_PROJECT.id}/wallets/wallet_one`);
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("useWalletActivityWindow", () => {
  it("shows the wider window once it loads, and widens from there", async () => {
    const fetchMock = stubActivityFeed((window) => dashboardDataResponse(200, payload(window)));
    const { result } = renderWindow(new Map());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(120));
    expect(result.current.loadingOlder).toBe(false);

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(220));
    expect(new Set(windowsRequested(fetchMock))).toEqual(new Set([20, 120, 220]));
  });

  it("keeps the loaded window when a wider read fails, and retries that same size", async () => {
    let widerFails = true;
    const fetchMock = stubActivityFeed((window) =>
      widerFails
        ? dashboardErrorResponse(503, "upstream unavailable")
        : dashboardDataResponse(200, payload(window))
    );
    const { result } = renderWindow(new Map());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.canLoadOlder).toBe(true);

    // Each retry asks for the window that failed, never a larger one.
    act(() => result.current.loadOlder());
    await waitFor(() =>
      expect(windowsRequested(fetchMock).filter((window) => window !== 20)).toEqual([120, 120])
    );
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(result.current.data?.activityRows).toHaveLength(20);

    widerFails = false;
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(120));
    expect(result.current.olderFailed).toBe(false);
    expect(Math.max(...windowsRequested(fetchMock))).toBe(120);
  });

  it("does not count a wider window cached by an earlier visit until a fresh read loads it", async () => {
    const cache = new Map<string, State>();
    stubActivityFeed((window) => dashboardDataResponse(200, payload(window)));
    const firstVisit = renderWindow(cache);
    await waitFor(() => expect(firstVisit.result.current.data?.activityRows).toHaveLength(20));
    act(() => firstVisit.result.current.loadOlder());
    await waitFor(() => expect(firstVisit.result.current.data?.activityRows).toHaveLength(120));
    firstVisit.unmount();

    // Back on the wallet: the 120-row window is still cached, but reading it again fails.
    const fetchMock = stubActivityFeed(() => dashboardErrorResponse(503, "upstream unavailable"));
    const { result } = renderWindow(cache);
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));

    act(() => result.current.loadOlder());
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.loadingOlder).toBe(true);
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(windowsRequested(fetchMock).filter((window) => window === 120)).toEqual([120]);
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.canLoadOlder).toBe(true);
  });

  it("treats a wider read that loses a source as failed", async () => {
    stubActivityFeed(() =>
      dashboardDataResponse(200, payload(100, "Payments activity is unavailable right now."))
    );
    const { result } = renderWindow(new Map());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.data?.activityNotice).toBeNull();
  });
});
