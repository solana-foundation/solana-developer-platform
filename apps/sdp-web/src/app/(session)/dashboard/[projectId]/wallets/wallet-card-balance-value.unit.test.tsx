// @vitest-environment jsdom

import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  dashboardErrorResponse,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { resetDashboardNavigation } from "@/test/dashboard-navigation";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { WalletCardBalanceValue } from "./wallet-card-balance-value";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const WALLET_ID = "wal_test_card";
const SUMMARIES_URL = "/api/dashboard/wallets?includeBalances=true&view=summary";
const OWN_BALANCES_URL = `/api/dashboard/payments/wallets/${WALLET_ID}/balances`;

function balance(usdValue: number): CustodyWalletTokenBalance {
  return {
    token: "USDC",
    mint: "MintTest111111111111111111111111111111111111",
    amount: String(usdValue * 1_000_000),
    uiAmount: String(usdValue),
    decimals: 6,
    usdValue,
  };
}

function summaries(walletId: string, balances: CustodyWalletTokenBalance[]): Response {
  return Response.json({
    data: {
      wallets: [
        {
          id: `cwlt_${walletId}`,
          walletId,
          publicKey: "11111111111111111111111111111111",
          label: null,
          custodyConfigId: "cfg_test_1",
          isRuntimeExecutionAllowed: true,
          balances,
        },
      ],
    },
  });
}

function ownBalances(balances: CustodyWalletTokenBalance[]): Response {
  return Response.json({ data: { walletBalances: { balances } } });
}

function renderBalance() {
  return render(
    <DashboardReadsProvider>
      <EnglishI18n>
        <WalletCardBalanceValue walletId={WALLET_ID} />
      </EnglishI18n>
    </DashboardReadsProvider>
  );
}

function readPaths(fetchMock: ReturnType<typeof stubDashboardFetch>): string[] {
  return sentDashboardReads(fetchMock).map((read) => read.path);
}

beforeEach(() => {
  resetDashboardNavigation();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("WalletCardBalanceValue", () => {
  it("shows the wallet's total from the shared read and reads nothing else", async () => {
    const fetchMock = stubDashboardFetch(() => summaries(WALLET_ID, [balance(12)]));
    renderBalance();

    expect(await screen.findByText("$12.00")).toBeTruthy();
    expect(readPaths(fetchMock)).toEqual([SUMMARIES_URL]);
  });

  it.each([
    ["leaves the wallet out", () => summaries("wal_test_other", [])],
    ["fails", () => dashboardErrorResponse(503, "Balances unavailable")],
  ])("reads this wallet on its own when the shared read %s", async (_case, sharedAnswer) => {
    const fetchMock = stubDashboardFetch(({ path }) =>
      path === OWN_BALANCES_URL ? ownBalances([balance(10)]) : sharedAnswer()
    );
    renderBalance();

    expect(await screen.findByText("$10.00")).toBeTruthy();
    expect(screen.queryByText("(stale)")).toBeNull();
    expect(readPaths(fetchMock)).toEqual([SUMMARIES_URL, OWN_BALANCES_URL]);
  });

  it("shows no figure when the shared read and this wallet's own read both fail", async () => {
    stubDashboardFetch(() => dashboardErrorResponse(503, "Balances unavailable"));
    renderBalance();

    expect(await screen.findByText("—")).toBeTruthy();
  });

  it("re-reads the shared balances every 30 seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = stubDashboardFetch(() => summaries(WALLET_ID, [balance(12)]));
    renderBalance();

    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(readPaths(fetchMock)).toEqual([SUMMARIES_URL]);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(readPaths(fetchMock)).toEqual([SUMMARIES_URL, SUMMARIES_URL]);
  });

  it("keeps the last total, marked stale, when a re-read and this wallet's own read fail", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let sharedFails = false;
    stubDashboardFetch(() =>
      sharedFails
        ? dashboardErrorResponse(503, "Balances unavailable")
        : summaries(WALLET_ID, [balance(3)])
    );
    renderBalance();
    expect(await screen.findByText("$3.00")).toBeTruthy();

    sharedFails = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));

    await waitFor(() => expect(screen.getByText("$3.00").textContent).toBe("$3.00 (stale)"));
  });
});
