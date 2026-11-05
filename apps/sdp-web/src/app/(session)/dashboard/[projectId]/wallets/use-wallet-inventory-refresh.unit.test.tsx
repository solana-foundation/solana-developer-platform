// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import useSWR from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { useCounterparties } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { useCustodyWallets, useWalletBalances } from "./custody-reads";
import { useWalletInventoryRefresh } from "./use-wallet-inventory-refresh";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const WALLETS_URL = "/api/dashboard/wallets";
const OFF_SCREEN_BALANCES_URL = "/api/dashboard/payments/wallets/wal_test_2/balances";
const COUNTERPARTIES_URL = "/api/dashboard/counterparty?page=1&pageSize=20";

function answer(path: string): Response {
  if (path === WALLETS_URL) return Response.json({ data: { wallets: [] } });
  if (path === OFF_SCREEN_BALANCES_URL) {
    return Response.json({ data: { walletBalances: { balances: [] } } });
  }
  return Response.json({ data: { counterparties: [], total: 0 } });
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("useWalletInventoryRefresh", () => {
  it("refetches on-screen wallet reads in place, clears off-screen ones and refetches label-keyed inventories", async () => {
    const fetchMock = stubDashboardFetch(({ path }) => answer(path));
    const readLabelKeyedWallets = vi.fn(async () => []);
    const offScreenShown: { offScreenWalletId: string | null } = {
      offScreenWalletId: "wal_test_2",
    };
    const walletListRenders: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ offScreenWalletId }: { offScreenWalletId: string | null }) => {
        const wallets = useCustodyWallets();
        walletListRenders.push(wallets.data === undefined);
        useCounterparties({ page: 1, pageSize: 20 });
        useSWR(paymentsQueryKeys.actionWallets(), readLabelKeyedWallets);
        return {
          offScreenBalances: useWalletBalances(offScreenWalletId),
          refresh: useWalletInventoryRefresh(),
        };
      },
      { wrapper: DashboardReadsProvider, initialProps: offScreenShown }
    );
    await waitFor(() => expect(result.current.offScreenBalances.data).toEqual([]));
    await waitFor(() => expect(walletListRenders.at(-1)).toBe(false));
    expect(
      sentDashboardReads(fetchMock)
        .map((read) => read.path)
        .sort()
    ).toEqual([COUNTERPARTIES_URL, OFF_SCREEN_BALANCES_URL, WALLETS_URL]);
    rerender({ offScreenWalletId: null });
    fetchMock.mockClear();
    walletListRenders.length = 0;

    act(() => result.current.refresh());

    await waitFor(() => expect(readLabelKeyedWallets).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(sentDashboardReads(fetchMock).map((read) => read.path)).toEqual([WALLETS_URL])
    );
    expect(new Set(walletListRenders)).toEqual(new Set([false]));
    rerender(offScreenShown);
    expect(result.current.offScreenBalances.data).toBeUndefined();
  });
});
