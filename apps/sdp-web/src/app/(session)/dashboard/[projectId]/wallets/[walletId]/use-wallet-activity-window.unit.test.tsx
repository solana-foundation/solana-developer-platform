// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
  WalletActivityPayload,
  WalletActivityRow,
} from "@/app/(session)/dashboard/[projectId]/wallets/wallet-activity.data";
import {
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { useWalletActivityWindow } from "./use-wallet-activity-window";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const ACTIVITY_PATH = "/api/dashboard/wallets/wallet_one/activity";

function rowsOf(count: number): WalletActivityRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `payment-xfr_${index}`,
    sourceKind: "payments",
    operationLabel: "Outgoing",
    status: "finalized",
    signature: null,
    token: "USDC",
    amount: "1.00",
    createdAt: "2026-09-11T00:00:00.000Z",
  }));
}

function payload(count: number, overrides: Partial<WalletActivityPayload> = {}) {
  return {
    activityRows: rowsOf(count),
    activityError: null,
    activityNotice: null,
    hasMore: true,
    ...overrides,
  } satisfies WalletActivityPayload;
}

/** Renders over `cache`, so a test can revisit the wallet with what an earlier visit left. */
function CachedWrapper({ cache, children }: { cache: Map<string, unknown>; children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => cache as never, shouldRetryOnError: false, dedupingInterval: 0 }}
    >
      {children}
    </SWRConfig>
  );
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{ provider: () => new Map(), shouldRetryOnError: false, dedupingInterval: 0 }}
    >
      {children}
    </SWRConfig>
  );
}

let fetchMock: Mock<typeof fetch>;

function limitOf(path: string): number {
  return path === ACTIVITY_PATH ? 20 : Number(path.slice(`${ACTIVITY_PATH}?limit=`.length));
}

function answerActivity(answer: (limit: number) => WalletActivityPayload | Response) {
  fetchMock = stubDashboardFetch(({ path }) => {
    const answered = answer(limitOf(path));
    return answered instanceof Response ? answered : Response.json({ data: answered });
  });
}

function limitsRequested(): number[] {
  return sentDashboardReads(fetchMock).map(({ path }) => limitOf(path));
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useWalletActivityWindow", () => {
  it("shows the wider window once it loads, and widens from there", async () => {
    answerActivity((limit) => payload(limit));
    const { result } = renderHook(() => useWalletActivityWindow("wallet_one"), { wrapper });
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(120));
    expect(result.current.loadingOlder).toBe(false);

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(220));
  });

  it("keeps the loaded window when a wider read fails, and retries that same size", async () => {
    let widerFails = true;
    answerActivity((limit) =>
      limit > 20 && widerFails
        ? dashboardErrorResponse(502, "upstream unavailable")
        : payload(limit)
    );
    const { result } = renderHook(() => useWalletActivityWindow("wallet_one"), { wrapper });
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.canLoadOlder).toBe(true);

    // Each retry asks for the window that failed, never a larger one.
    act(() => result.current.loadOlder());
    await waitFor(() => expect(limitsRequested().filter((limit) => limit !== 20)).toHaveLength(2));
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(limitsRequested().filter((limit) => limit !== 20)).toEqual([120, 120]);
    expect(result.current.data?.activityRows).toHaveLength(20);

    widerFails = false;
    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(120));
    expect(result.current.olderFailed).toBe(false);
    expect(Math.max(...limitsRequested())).toBe(120);
  });

  it("does not count a wider window cached by an earlier visit until a fresh read loads it", async () => {
    const cache = new Map<string, unknown>();
    answerActivity((limit) => payload(limit));
    const firstVisit = renderHook(() => useWalletActivityWindow("wallet_one"), {
      wrapper: ({ children }) => <CachedWrapper cache={cache}>{children}</CachedWrapper>,
    });
    await waitFor(() => expect(firstVisit.result.current.data?.activityRows).toHaveLength(20));
    act(() => firstVisit.result.current.loadOlder());
    await waitFor(() => expect(firstVisit.result.current.data?.activityRows).toHaveLength(120));
    firstVisit.unmount();

    // Back on the wallet: the 120-row window is still cached, but reading it again fails.
    answerActivity((limit) =>
      limit > 20 ? dashboardErrorResponse(502, "upstream unavailable") : payload(limit)
    );
    const { result } = renderHook(() => useWalletActivityWindow("wallet_one"), {
      wrapper: ({ children }) => <CachedWrapper cache={cache}>{children}</CachedWrapper>,
    });
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));
    const widerReadsBefore = limitsRequested().filter((limit) => limit === 120).length;

    act(() => result.current.loadOlder());
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.loadingOlder).toBe(true);
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(limitsRequested().filter((limit) => limit === 120).length).toBe(widerReadsBefore + 1);
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.loadingOlder).toBe(false);
    expect(result.current.canLoadOlder).toBe(true);
  });

  it("treats a wider read that loses a source as failed", async () => {
    answerActivity((limit) =>
      limit > 20
        ? payload(100, { activityNotice: "Payments activity is unavailable right now." })
        : payload(20)
    );
    const { result } = renderHook(() => useWalletActivityWindow("wallet_one"), { wrapper });
    await waitFor(() => expect(result.current.data?.activityRows).toHaveLength(20));

    act(() => result.current.loadOlder());
    await waitFor(() => expect(result.current.olderFailed).toBe(true));
    expect(result.current.data?.activityRows).toHaveLength(20);
    expect(result.current.data?.activityNotice).toBeNull();
  });
});
