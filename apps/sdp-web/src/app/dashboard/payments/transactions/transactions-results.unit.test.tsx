// @vitest-environment jsdom

import type { UnifiedTransaction } from "@sdp/types";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import { TransactionDetailWorkspace } from "./transaction-detail-workspace";
import type { TransactionsPageResult } from "./transactions-page.data";
import type { TransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

vi.mock("@/lib/dashboard-url-state", () => ({
  replaceDashboardSearchParams: vi.fn(),
}));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  usePathname: () => "/dashboard/payments/transactions/xfr_pay",
}));

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
    <SWRConfig value={{ provider: () => new Map() }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <TransactionsWorkspace
          initialFilters={filters}
          initialResult={result}
          issuedTokensByMint={ISSUED_TOKENS}
          wallets={[]}
          counterparties={[{ id: "cpty_test", name: "Acme Treasury" }]}
        />
      </I18nProvider>
    </SWRConfig>
  );
}

afterEach(() => {
  cleanup();
  router.push.mockClear();
});

function renderDetail(transaction: UnifiedTransaction) {
  return render(
    <I18nProvider locale="en" messages={getMessages("en")}>
      <TransactionDetailWorkspace
        transaction={transaction}
        transfer={null}
        issuedTokensByMint={ISSUED_TOKENS}
      />
    </I18nProvider>
  );
}

describe("TransactionsResults", () => {
  it("renders payments states in their own words and other modules by ledger status", () => {
    renderResults({ transactions: [PAYMENT, DVP_LEG], nextCursor: "cursor_2" }, { cursors: [] });

    for (const header of ["Status", "Type", "Amount", "Contact", "Wallet", "Created"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeDefined();
    }
    expect(screen.getByText("Pay")).toBeDefined();
    expect(screen.getByText("Fund leg")).toBeDefined();
    expect(screen.getByText("Confirmed")).toBeDefined();
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("resolves the token symbol, the contact name and the wallet label per row", () => {
    renderResults({ transactions: [PAYMENT], nextCursor: null }, { cursors: [] });

    expect(screen.getByText("12.50").parentElement?.textContent).toBe("12.50 ACME");
    expect(screen.getByText("Acme Treasury")).toBeDefined();
    expect(screen.getByText("Treasury")).toBeDefined();
  });

  it("opens a transaction's page from its row, by click or Enter", () => {
    renderResults({ transactions: [PAYMENT, DVP_LEG], nextCursor: null }, { cursors: [] });

    fireEvent.click(screen.getByText("Pay"));
    expect(router.push).toHaveBeenLastCalledWith("/dashboard/payments/transactions/xfr_pay");

    const dvpRow = screen.getByText("Fund leg").closest("tr") as HTMLElement;
    fireEvent.keyDown(dvpRow, { key: "Enter" });
    expect(router.push).toHaveBeenLastCalledWith(
      "/dashboard/payments/transactions/dvp_trade%3Afund%3Aa"
    );
  });

  it("gives a payment's page its explorer link and another module's page the way to it", () => {
    renderDetail(PAYMENT);
    expect(screen.getByText("View on explorer").closest("a")?.getAttribute("href")).toContain(
      "/tx/sig_pay"
    );
    expect(screen.queryByText("View in Payments")).toBeNull();
    cleanup();

    renderDetail(DVP_LEG);
    expect(
      screen.getByText("View in Delivery vs Payments").closest("a")?.getAttribute("href")
    ).toBe("/dashboard/markets/dvp/dvp_trade");
  });

  it("shows the empty state when nothing matches", () => {
    renderResults({ transactions: [], nextCursor: null }, { module: "earn", cursors: [] });
    expect(screen.getByText("No transactions found")).toBeDefined();
  });
});
