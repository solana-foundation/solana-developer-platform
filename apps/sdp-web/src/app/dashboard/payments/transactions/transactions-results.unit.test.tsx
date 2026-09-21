// @vitest-environment jsdom

import type { UnifiedTransaction } from "@sdp/types";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/i18n/messages";
import { I18nProvider } from "@/i18n/provider";
import type { PaymentsIssuedTokenSymbol } from "../payments-page.data";
import type { TransactionsPageResult } from "./transactions-page.data";
import type { TransactionFilters } from "./transactions-query";
import { TransactionsWorkspace } from "./transactions-workspace";

const urlState = vi.hoisted(() => ({ tab: null as string | null }));
vi.mock("@/lib/dashboard-url-state", () => ({
  useDashboardTab: () => urlState.tab,
  readDashboardTabFromUrl: () => urlState.tab,
  replaceDashboardSearchParams: vi.fn(),
}));
vi.mock("@/lib/use-solana-cluster", () => ({ useSolanaCluster: () => "devnet" }));

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
  urlState.tab = filters.module === undefined ? null : filters.module;
  return render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <I18nProvider locale="en" messages={getMessages("en")}>
        <TransactionsWorkspace
          initialFilters={filters}
          initialResult={result}
          issuedTokensByMint={ISSUED_TOKENS}
        />
      </I18nProvider>
    </SWRConfig>
  );
}

afterEach(cleanup);

describe("TransactionsResults", () => {
  it("renders module, kind and status labels from the registry on the All tab", () => {
    renderResults({ transactions: [PAYMENT, DVP_LEG], nextCursor: "cursor_2" }, { cursors: [] });

    expect(screen.getByRole("columnheader", { name: "Module" })).toBeDefined();
    expect(screen.getByText("Payments")).toBeDefined();
    expect(screen.getByText("Delivery vs Payments")).toBeDefined();
    expect(screen.getByText("Pay")).toBeDefined();
    expect(screen.getByText("Fund leg")).toBeDefined();
    expect(screen.getByText("confirmed")).toBeDefined();
    expect(screen.getByText("funded")).toBeDefined();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("resolves the issued token symbol, the wallet label and an explorer link per row", () => {
    renderResults({ transactions: [PAYMENT], nextCursor: null }, { cursors: [] });

    expect(screen.getByText("12.5 ACME")).toBeDefined();
    expect(screen.getByText("Treasury").closest("a")?.getAttribute("href")).toBe(
      "/dashboard/wallets/cwlt_test"
    );
    const signature = screen.getByText("sig_pay").closest("a");
    expect(signature?.getAttribute("href")).toBe(
      "https://explorer.solana.com/tx/sig_pay?cluster=devnet"
    );
    expect(signature?.getAttribute("target")).toBe("_blank");
  });

  it("hides the module column inside a module tab and opens the detail modal", () => {
    renderResults(
      { transactions: [PAYMENT], nextCursor: null },
      { module: "payments", cursors: [] }
    );

    expect(screen.queryByRole("columnheader", { name: "Module" })).toBeNull();
    act(() => {
      fireEvent.click(screen.getByText("Pay"));
    });
    expect(screen.getByText("Transaction details")).toBeDefined();
    expect(screen.queryByText("View in Payments")).toBeNull();
    expect(screen.getByText("cpty_test").closest("a")?.getAttribute("href")).toBe(
      "/dashboard/payments/counterparty/cpty_test"
    );
  });

  it("keeps the link to a transaction's distinct module detail", () => {
    renderResults({ transactions: [DVP_LEG], nextCursor: null }, { cursors: [] });
    fireEvent.click(screen.getByText("Fund leg"));
    expect(
      screen.getByText("View in Delivery vs Payments").closest("a")?.getAttribute("href")
    ).toBe("/dashboard/markets/dvp/dvp_trade");
  });

  it("shows the empty state when nothing matches", () => {
    renderResults({ transactions: [], nextCursor: null }, { module: "earn", cursors: [] });
    expect(screen.getByText("No transactions found")).toBeDefined();
  });
});
