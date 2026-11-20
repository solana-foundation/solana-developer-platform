// @vitest-environment jsdom

import {
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransaction,
} from "@sdp/types/unified-transactions";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentsIssuedTokenSymbol } from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";
import {
  dashboardDataResponse,
  sentDashboardRequests,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { dashboardRouter, resetDashboardNavigation } from "@/test/dashboard-navigation";
import { EnglishI18n } from "@/test/i18n";
import { stubMatchMedia } from "@/test/media-queries";
import { FreshSWRCache } from "@/test/swr";
import { restoreWindowLocation, setWindowPathname } from "@/test/window-location";
import { TransactionDetailWorkspace } from "./transaction-detail-workspace";
import { enabledPaymentTransactionKinds } from "./transaction-modules";
import type { TransactionsPageResult } from "./transactions-page.data";
import type { TransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

vi.mock("next/navigation", () => import("@/test/next-navigation"));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

const TRANSACTIONS_PATH = "/dashboard/prj_test_sandbox/payments/transactions";

const ISSUED_TOKENS: Record<string, PaymentsIssuedTokenSymbol> = {
  Mint111: { id: "tok_1", mintAddress: "Mint111", symbol: "ACME", imageUrl: null },
};

const PAYMENT: UnifiedTransaction = {
  id: "xfr_pay",
  module: "payments",
  kind: "pay",
  moduleId: "xfr_pay",
  moduleStatus: "confirmed",
  status: "succeeded",
  organizationId: "org_test",
  projectId: "prj_test",
  custodyWalletId: "cwlt_test",
  custodyWalletLabel: "Treasury",
  token: "Mint111",
  amount: "12.5",
  counterpartyId: "cpty_test",
  signature: "sig_pay",
  createdAt: "2026-09-15T10:00:00.000Z",
};

const DVP_LEG: UnifiedTransaction = {
  id: "dvp_trade:fund:a",
  module: "dvp",
  kind: "fund",
  moduleId: "dvp_trade",
  moduleStatus: "funded",
  status: "pending",
  organizationId: "org_test",
  projectId: "prj_test",
  custodyWalletId: null,
  custodyWalletLabel: null,
  token: null,
  amount: null,
  counterpartyId: null,
  signature: null,
  createdAt: "2026-09-14T10:00:00.000Z",
};

function renderResults(result: TransactionsPageResult, filters: TransactionFilters) {
  return render(
    <FreshSWRCache>
      <EnglishI18n>
        <TransactionsWorkspace
          initialFilters={filters}
          initialResult={result}
          issuedTokensByMint={ISSUED_TOKENS}
          wallets={[]}
          counterparties={[{ id: "cpty_test", name: "Acme Treasury" }]}
          modules={UNIFIED_TRANSACTION_MODULES}
          paymentKinds={enabledPaymentTransactionKinds({ ramps: true })}
        />
      </EnglishI18n>
    </FreshSWRCache>
  );
}

function renderDetail(transaction: UnifiedTransaction) {
  return render(
    <EnglishI18n>
      <TransactionDetailWorkspace
        transaction={transaction}
        transfer={null}
        issuedTokensByMint={ISSUED_TOKENS}
      />
    </EnglishI18n>
  );
}

/** The status, amount, contact and wallet cells of the row whose type reads `kind`. */
function rowCells(kind: string) {
  const row = screen.getByText(kind).closest("tr") as HTMLElement;
  const [status, , amount, contact, wallet] = within(row)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
  return { status, amount, contact, wallet };
}

beforeEach(() => {
  resetDashboardNavigation();
  stubMatchMedia();
  setWindowPathname(TRANSACTIONS_PATH);
});

afterEach(() => {
  cleanup();
  restoreWindowLocation();
  vi.unstubAllGlobals();
});

describe("TransactionsResults", () => {
  it("shows a payment by its own status, with its token, contact and wallet named", () => {
    renderResults({ transactions: [PAYMENT], nextCursor: null }, { cursors: [] });

    expect(rowCells("Pay")).toEqual({
      status: "Confirmed",
      amount: "12.50 ACME",
      contact: "Acme Treasury",
      wallet: "Treasury",
    });
  });

  it("shows another module's row by its ledger status, with dashes for what it lacks", () => {
    renderResults({ transactions: [DVP_LEG], nextCursor: null }, { cursors: [] });

    expect(rowCells("Fund leg")).toEqual({
      status: "Pending",
      amount: "—",
      contact: "—",
      wallet: "—",
    });
  });

  it("opens a transaction's page from its row, by click or Enter", () => {
    renderResults({ transactions: [PAYMENT, DVP_LEG], nextCursor: null }, { cursors: [] });

    fireEvent.click(screen.getByText("Pay"));
    expect(dashboardRouter.push).toHaveBeenLastCalledWith(`${TRANSACTIONS_PATH}/xfr_pay`);

    const dvpRow = screen.getByText("Fund leg").closest("tr") as HTMLElement;
    fireEvent.keyDown(dvpRow, { key: "Enter" });
    expect(dashboardRouter.push).toHaveBeenLastCalledWith(
      `${TRANSACTIONS_PATH}/dvp_trade%3Afund%3Aa`
    );
  });

  it("reads the next page with the cursor the API returned, and puts it in the URL", async () => {
    const fetchMock = stubDashboardFetch(() =>
      dashboardDataResponse(200, { transactions: [], nextCursor: null })
    );
    renderResults({ transactions: [PAYMENT], nextCursor: "cursor_2" }, { cursors: [] });

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() =>
      expect(sentDashboardRequests(fetchMock).map((request) => request.path)).toEqual([
        "/api/dashboard/payments/transactions?limit=25&cursor=cursor_2",
      ])
    );
    expect(window.location.search).toBe("?cursor=cursor_2&cursors=cursor_2");
  });

  it("gives a payment's page its explorer link and another module's page the way to it", () => {
    renderDetail(PAYMENT);
    expect(screen.getByText("View on explorer").closest("a")?.getAttribute("href")).toBe(
      "https://explorer.solana.com/tx/sig_pay?cluster=devnet"
    );
    expect(screen.queryByText("View in Payments")).toBeNull();
    cleanup();

    renderDetail(DVP_LEG);
    expect(
      screen.getByText("View in Delivery vs Payments").closest("a")?.getAttribute("href")
    ).toBe("/dashboard/prj_test_sandbox/markets/dvp/dvp_trade");
  });

  it("shows the empty state when nothing matches", () => {
    renderResults({ transactions: [], nextCursor: null }, { module: "earn", cursors: [] });
    expect(screen.getByText("No transactions found")).toBeDefined();
  });
});
