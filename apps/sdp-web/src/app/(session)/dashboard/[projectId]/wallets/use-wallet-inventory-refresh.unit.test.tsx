// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCounterparties } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { sentDashboardReads, stubDashboardFetch } from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { useCustodyWallets, useWalletBalances } from "./custody-reads";
import { useWalletInventoryRefresh } from "./use-wallet-inventory-refresh";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const WALLETS_URL = "/api/dashboard/wallets";
const BALANCES_URL = "/api/dashboard/payments/wallets/wal_test_1/balances";
const COUNTERPARTIES_URL = "/api/dashboard/counterparty?page=1&pageSize=20";

function answer(path: string): Response {
  if (path === WALLETS_URL) return Response.json({ data: { wallets: [] } });
  if (path === BALANCES_URL) return Response.json({ data: { walletBalances: { balances: [] } } });
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
  it("re-reads the wallet list and balances on screen, and leaves other reads alone", async () => {
    const fetchMock = stubDashboardFetch(({ path }) => answer(path));
    const { result } = renderHook(
      () => {
        useCustodyWallets();
        useWalletBalances("wal_test_1");
        useCounterparties({ page: 1, pageSize: 20 });
        return useWalletInventoryRefresh();
      },
      { wrapper: DashboardReadsProvider }
    );
    await waitFor(() =>
      expect(
        sentDashboardReads(fetchMock)
          .map((read) => read.path)
          .sort()
      ).toEqual([COUNTERPARTIES_URL, BALANCES_URL, WALLETS_URL])
    );
    fetchMock.mockClear();

    act(() => result.current());

    await waitFor(() =>
      expect(
        sentDashboardReads(fetchMock)
          .map((read) => read.path)
          .sort()
      ).toEqual([BALANCES_URL, WALLETS_URL])
    );
  });
});
