// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import useSWR from "swr";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { z } from "zod";
import { PaymentsDemoProvider } from "@/lib/payments-demo/payments-demo-context";
import {
  dashboardDataResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import {
  type DashboardKeyScope,
  dashboardRequestKey,
  readsUnderPath,
} from "./dashboard-request-key";
import {
  DashboardReadError,
  useDashboardKeyScope,
  useDashboardRead,
  useInvalidateDashboardReads,
} from "./dashboard-swr";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const SCOPE: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "live" };
const WALLETS_KEY = dashboardRequestKey(SCOPE, "/api/dashboard/wallets");
const COUNTERPARTIES_KEY = dashboardRequestKey(SCOPE, "/api/dashboard/counterparty");
const LABEL_KEY = ["wallet-activity", "wal_test_1"] as const;
const amountSchema = z.object({ data: z.object({ amount: z.number() }) });

function readsOf(fetchMock: Mock<typeof fetch>, path: string): number {
  return sentDashboardReads(fetchMock).filter((read) => read.path === path).length;
}

function stubCountingReads(): Mock<typeof fetch> {
  const fetchMock = stubDashboardFetch(({ path }) =>
    dashboardDataResponse(200, { amount: readsOf(fetchMock, path) })
  );
  return fetchMock;
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("useDashboardRead", () => {
  it.each([
    ["live", null],
    ["demo", "1"],
  ] as const)("sends a %s read under the key's Project, not the tab's URL", async (mode, demo) => {
    setWindowPathname(`/dashboard/${PRODUCTION_PROJECT.id}/wallets`);
    const fetchMock = stubDashboardFetch(() => dashboardDataResponse(200, { amount: 7 }));
    const key = dashboardRequestKey(
      { projectId: SANDBOX_PROJECT.id, mode },
      "/api/dashboard/wallets",
      {
        view: "summary",
      }
    );

    const { result } = renderHook(() => useDashboardRead(key, amountSchema), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.data).toEqual({ data: { amount: 7 } }));
    expect(sentDashboardReads(fetchMock)).toEqual([
      { path: "/api/dashboard/wallets?view=summary", projectId: SANDBOX_PROJECT.id, demo },
    ]);
  });

  it("fails a refused read with its status and the API's error code", async () => {
    stubDashboardFetch(() =>
      Response.json({ error: { code: "FORBIDDEN", message: "No access" } }, { status: 403 })
    );

    const { result } = renderHook(() => useDashboardRead(WALLETS_KEY, amountSchema), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(DashboardReadError));
    expect(result.current.error).toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it.each([
    ["a body its schema rejects", () => dashboardDataResponse(200, { amount: "7" })],
    ["a body that is not JSON", () => new Response("<html></html>", { status: 200 })],
  ])("fails a read answered with %s, with no code", async (_case, answer) => {
    stubDashboardFetch(answer);

    const { result } = renderHook(() => useDashboardRead(WALLETS_KEY, amountSchema), {
      wrapper: DashboardReadsProvider,
    });

    await waitFor(() => expect(result.current.error).toBeInstanceOf(DashboardReadError));
    expect(result.current.error).toMatchObject({ status: 200, code: null });
    expect(result.current.data).toBeUndefined();
  });
});

describe("useDashboardKeyScope", () => {
  it.each([
    [true, "demo"],
    [false, "live"],
  ] as const)("scopes keys to the URL's Project, demo %s reading as %s", (demo, mode) => {
    const { result } = renderHook(() => useDashboardKeyScope(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <PaymentsDemoProvider value={demo}>{children}</PaymentsDemoProvider>
      ),
    });

    expect(result.current).toEqual({ projectId: SANDBOX_PROJECT.id, mode });
  });
});

function useReads({ walletsMounted }: { walletsMounted: boolean }) {
  return {
    invalidate: useInvalidateDashboardReads(),
    wallets: useDashboardRead(walletsMounted ? WALLETS_KEY : null, amountSchema),
    counterparties: useDashboardRead(COUNTERPARTIES_KEY, amountSchema),
  };
}

describe("useInvalidateDashboardReads", () => {
  it("refetches a mounted matching read and leaves the others alone", async () => {
    const fetchMock = stubCountingReads();
    const { result } = renderHook(useReads, {
      wrapper: DashboardReadsProvider,
      initialProps: { walletsMounted: true },
    });
    await waitFor(() => expect(result.current.counterparties.data).toBeDefined());
    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 1 } }));

    await act(() => result.current.invalidate(readsUnderPath("/api/dashboard/wallets")));

    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 2 } }));
    expect(readsOf(fetchMock, "/api/dashboard/counterparty")).toBe(1);
    expect(result.current.counterparties.data).toEqual({ data: { amount: 1 } });
  });

  it("clears an unmounted matching read, so mounting it again shows loading", async () => {
    stubCountingReads();
    const { result, rerender } = renderHook(useReads, {
      wrapper: DashboardReadsProvider,
      initialProps: { walletsMounted: true },
    });
    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 1 } }));
    rerender({ walletsMounted: false });

    await act(() => result.current.invalidate(readsUnderPath("/api/dashboard/wallets")));
    rerender({ walletsMounted: true });

    expect(result.current.wallets.data).toBeUndefined();
    expect(result.current.wallets.isLoading).toBe(true);
    await waitFor(() => expect(result.current.wallets.data).toEqual({ data: { amount: 2 } }));
  });

  it("never touches a key that is not a request key, whatever the predicate matches", async () => {
    const fetchMock = stubCountingReads();
    const labelFetcher = vi.fn(async () => "label");
    const { result } = renderHook(
      () => ({
        invalidate: useInvalidateDashboardReads(),
        wallets: useDashboardRead(WALLETS_KEY, amountSchema),
        label: useSWR(LABEL_KEY, labelFetcher),
      }),
      { wrapper: DashboardReadsProvider }
    );
    await waitFor(() => expect(result.current.label.data).toBe("label"));
    await waitFor(() => expect(result.current.wallets.data).toBeDefined());

    await act(() => result.current.invalidate(() => true));

    await waitFor(() => expect(readsOf(fetchMock, "/api/dashboard/wallets")).toBe(2));
    expect(labelFetcher).toHaveBeenCalledTimes(1);
    expect(result.current.label.data).toBe("label");
  });
});
