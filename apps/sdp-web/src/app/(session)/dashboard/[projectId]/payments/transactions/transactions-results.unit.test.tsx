// @vitest-environment jsdom

import {
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransaction,
} from "@sdp/types/unified-transactions";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type SentDashboardRequest,
  sentDashboardReads,
  stubDashboardFetch,
} from "@/test/dashboard-fetch";
import { DashboardReadsProvider } from "@/test/dashboard-reads";
import { EnglishI18n } from "@/test/i18n";
import { stubMatchMedia } from "@/test/media-queries";
import { TransactionDetailWorkspace } from "./transaction-detail-workspace";
import { enabledPaymentTransactionKinds } from "./transaction-modules";
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
  useParams: () => ({ projectId: "prj_test_sandbox" }),
  usePathname: () => "/dashboard/prj_test_sandbox/payments/transactions/xfr_pay",
}));

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

type Answer = (request: SentDashboardRequest) => Response | Promise<Response>;

/** The Project's names for rows: its issued ACME token, the contact, and no wallets. */
const nameReads: Answer = ({ path, method }) => {
  if (path.startsWith("/api/dashboard/issuance/tokens?")) {
    return Response.json({
      data: [{ id: "tok_1", name: "Acme", decimals: 6, mintAddress: "Mint111", symbol: "ACME" }],
      total: 1,
      hasMore: false,
    });
  }
  if (path.startsWith("/api/dashboard/counterparty?")) {
    return Response.json({
      data: {
        counterparties: [{ id: "cpty_test", displayName: "Acme Treasury", entityType: "business" }],
        total: 1,
      },
    });
  }
  if (path === "/api/dashboard/counterparty/cpty_test") {
    return Response.json({
      data: {
        counterparty: {
          id: "cpty_test",
          organizationId: "org_test",
          projectId: "prj_test",
          externalId: null,
          entityType: "business",
          displayName: "Acme Treasury",
          status: "active",
          createdBy: null,
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
        },
      },
    });
  }
  if (path.startsWith("/api/dashboard/wallets")) return Response.json({ data: { wallets: [] } });
  if (path.startsWith("/api/dashboard/payments/transfers/")) {
    return Response.json({ error: { message: "not found" } }, { status: 404 });
  }
  throw new Error(`unexpected ${method} ${path}`);
};

function page(transactions: readonly UnifiedTransaction[]): Response {
  return Response.json({ data: { transactions, nextCursor: null } });
}

function isLedgerRead(read: { path: string }): boolean {
  return read.path.startsWith("/api/dashboard/payments/transactions?");
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <EnglishI18n>
      <DashboardReadsProvider>{children}</DashboardReadsProvider>
    </EnglishI18n>
  );
}

function renderWorkspace(filters: TransactionFilters, ledger: Answer) {
  const fetchMock = stubDashboardFetch((request) =>
    isLedgerRead(request) ? ledger(request) : nameReads(request)
  );
  render(
    <TransactionsWorkspace
      initialFilters={filters}
      issuanceEnabled
      modules={UNIFIED_TRANSACTION_MODULES}
      paymentKinds={enabledPaymentTransactionKinds({ ramps: true })}
    />,
    { wrapper }
  );
  return fetchMock;
}

async function renderResults(result: TransactionsPageResult, filters: TransactionFilters) {
  renderWorkspace(filters, () => page(result.transactions));
  await waitFor(() =>
    expect(document.querySelector("[data-loading-transaction-results]")).toBeNull()
  );
}

const served: { rows: UnifiedTransaction[] } = { rows: [] };

function renderDetail(transactionId: string) {
  const fetchMock = stubDashboardFetch((request) =>
    isLedgerRead(request) ? page(served.rows) : nameReads(request)
  );
  render(<TransactionDetailWorkspace transactionId={transactionId} issuanceEnabled />, {
    wrapper,
  });
  return fetchMock;
}

beforeEach(() => {
  stubMatchMedia();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  router.push.mockClear();
});

describe("TransactionsResults", () => {
  it("renders payments states in their own words and other modules by ledger status", async () => {
    await renderResults(
      { transactions: [PAYMENT, DVP_LEG], nextCursor: "cursor_2" },
      { cursors: [] }
    );

    for (const header of ["Status", "Type", "Amount", "Contact", "Wallet", "Created"]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeDefined();
    }
    expect(screen.getByText("Pay")).toBeDefined();
    expect(screen.getByText("Fund leg")).toBeDefined();
    expect(screen.getByText("Confirmed")).toBeDefined();
    expect(screen.getByText("Pending")).toBeDefined();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("resolves the token symbol, the contact name and the wallet label per row", async () => {
    await renderResults({ transactions: [PAYMENT], nextCursor: null }, { cursors: [] });

    await waitFor(() =>
      expect(screen.getByText("12.50").parentElement?.textContent).toBe("12.50 ACME")
    );
    await waitFor(() => expect(screen.getAllByText("Acme Treasury")).toHaveLength(2));
    expect(screen.getByText("Treasury")).toBeDefined();
  });

  it("opens a transaction's page from its row, by click or Enter", async () => {
    await renderResults({ transactions: [PAYMENT, DVP_LEG], nextCursor: null }, { cursors: [] });

    fireEvent.click(screen.getByText("Pay"));
    expect(router.push).toHaveBeenLastCalledWith(
      "/dashboard/prj_test_sandbox/payments/transactions/xfr_pay"
    );

    const dvpRow = screen.getByText("Fund leg").closest("tr");
    if (dvpRow === null) throw new Error("no Fund leg row");
    fireEvent.keyDown(dvpRow, { key: "Enter" });
    expect(router.push).toHaveBeenLastCalledWith(
      "/dashboard/prj_test_sandbox/payments/transactions/dvp_trade%3Afund%3Aa"
    );
  });

  it("keeps the previous results on screen while a new search loads", async () => {
    const searched = Promise.withResolvers<Response>();
    const fetchMock = renderWorkspace({ cursors: [] }, ({ path }) =>
      path.includes("search=") ? searched.promise : page([PAYMENT])
    );
    expect(await screen.findByText("Pay")).toBeDefined();

    const search = screen.getByRole("searchbox", { name: "Search transactions" });
    fireEvent.change(search, { target: { value: "dvp_" } });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => expect(sentDashboardReads(fetchMock).filter(isLedgerRead)).toHaveLength(2));
    expect(document.querySelector("[data-loading-transaction-results]")).toBeNull();
    expect(screen.getByText("Pay")).toBeDefined();
    searched.resolve(page([DVP_LEG]));
    expect(await screen.findByText("Fund leg")).toBeDefined();
    expect(screen.queryByText("Pay")).toBeNull();
  });

  it("shows the empty state when nothing matches", async () => {
    await renderResults({ transactions: [], nextCursor: null }, { module: "earn", cursors: [] });
    expect(screen.getByText("No transactions found")).toBeDefined();
  });
});

describe("TransactionDetailWorkspace", () => {
  it("gives a payment's page its explorer link and another module's page the way to it", async () => {
    served.rows = [PAYMENT];
    renderDetail(PAYMENT.id);
    const explorer = await screen.findByText("View on explorer");
    expect(explorer.closest("a")?.getAttribute("href")).toContain("/tx/sig_pay");
    expect(screen.queryByText("View in Payments")).toBeNull();
    cleanup();

    served.rows = [DVP_LEG];
    renderDetail(DVP_LEG.id);
    const dvp = await screen.findByText("View in Delivery vs Payments");
    expect(dvp.closest("a")?.getAttribute("href")).toBe(
      "/dashboard/prj_test_sandbox/markets/dvp/dvp_trade"
    );
  });

  it("shows the Project's not-found page when the ledger holds no row with that exact id", async () => {
    served.rows = [{ ...PAYMENT, id: "xfr_pay_other" }];
    renderDetail(PAYMENT.id);

    expect(await screen.findByRole("link", { name: "Back to Overview" })).toBeDefined();
  });

  it("reads a pending payment again until it settles, then stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    served.rows = [{ ...PAYMENT, status: "pending", moduleStatus: "pending" }];
    const fetchMock = renderDetail(PAYMENT.id);
    await screen.findByText("View on explorer");
    const ledgerReads = () => sentDashboardReads(fetchMock).filter(isLedgerRead).length;
    expect(ledgerReads()).toBe(1);

    served.rows = [PAYMENT];
    await vi.advanceTimersByTimeAsync(15_000);
    await waitFor(() => expect(ledgerReads()).toBe(2));

    await vi.advanceTimersByTimeAsync(30_000);
    expect(ledgerReads()).toBe(2);
  });

  it("does not read another module's pending transaction again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    served.rows = [DVP_LEG];
    const fetchMock = renderDetail(DVP_LEG.id);
    await screen.findByText("View in Delivery vs Payments");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(sentDashboardReads(fetchMock).filter(isLedgerRead)).toHaveLength(1);
  });
});
