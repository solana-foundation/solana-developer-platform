import {
  type Counterparty,
  type CounterpartyAccount,
  type CounterpartyAccountSummary,
  type ListCounterpartiesResponse,
  type ListCounterpartyProviderAccountsResponse,
  type PaymentRecurringPayment,
  type PaymentRequest,
  type PaymentSubscriptionCollectionAttempt,
  type PaymentsDashboardWallet,
  type PaymentTransferSummary,
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  type UnifiedTransaction,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as counterpartyAccountsGET } from "@/app/api/dashboard/counterparty/[counterpartyId]/accounts/route";
import { GET as providerAccountsGET } from "@/app/api/dashboard/counterparty/[counterpartyId]/provider-accounts/route";
import { GET as projectAccountsGET } from "@/app/api/dashboard/counterparty/accounts/route";
import { GET as counterpartiesGET } from "@/app/api/dashboard/counterparty/route";
import { GET as recurringPaymentGET } from "@/app/api/dashboard/payments/recurring-payments/[recurringPaymentId]/route";
import { GET as recurringPaymentsGET } from "@/app/api/dashboard/payments/recurring-payments/route";
import { GET as transactionsGET } from "@/app/api/dashboard/payments/transactions/route";
import { GET as transfersGET } from "@/app/api/dashboard/payments/transfers/route";
import { GET as aggregateGET } from "@/app/api/dashboard/wallets/aggregate/route";
import { GET as walletsGET } from "@/app/api/dashboard/wallets/route";
import CounterpartyDetailRoute from "@/app/dashboard/payments/counterparty/[counterpartyId]/page";
import {
  fetchCounterparties,
  fetchCounterparty,
} from "@/app/dashboard/payments/counterparty/counterparty-page.data";
import CounterpartyPage from "@/app/dashboard/payments/counterparty/page";
import {
  normalizeAggregateBalances,
  resolveTotalBalance,
  selectTopAggregateBalanceRows,
} from "@/app/dashboard/payments/payments-overview.utils";
import {
  fetchDashboardPaymentTransfers,
  fetchIssuedTokensByMint,
  fetchPaymentsAggregate,
  fetchPaymentsIssuedTokenSymbols,
  fetchPaymentsWallets,
  fetchPaymentTransfers,
  fetchTransferBatches,
  fetchTransferBatchRecipients,
} from "@/app/dashboard/payments/payments-page.data";
import { summarizeBatch } from "@/app/dashboard/payments/payments-presentation";
import {
  fetchAllCounterparties,
  fetchBatchRecipients,
  fetchCounterpartyAccounts,
  fetchTransfers,
  fetchWalletAggregate,
  fetchWallets,
} from "@/app/dashboard/payments/payments-workspace.data";
import RecurringPaymentDetailRoute from "@/app/dashboard/payments/recurring/[recurringPaymentId]/page";
import RecurringPaymentsPage from "@/app/dashboard/payments/recurring/page";
import {
  fetchRecurringPaymentCollectionAttempts,
  fetchRecurringPayments,
  getRecurringPayment,
  listRecurringPayments,
} from "@/app/dashboard/payments/recurring/recurring-payments.data";
import PaymentRequestsPage from "@/app/dashboard/payments/requests/page";
import { fetchPaymentRequests } from "@/app/dashboard/payments/requests/payment-requests-page.data";
import TransactionsPage from "@/app/dashboard/payments/transactions/page";
import {
  fetchTransactionsPageFromDashboard,
  transactionsApiQuery,
} from "@/app/dashboard/payments/transactions/transactions-page.data";
import { parseTransactionFilters } from "@/app/dashboard/payments/transactions/transactions-query";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { paymentsDemoBody } from "./demo-fixtures";

/*
 * Every demo body goes through the parsers the Payments screens use: the server pages and data
 * functions read it through a fake `request` that answers from the fixtures, and the client
 * fetchers reach it through the real dashboard API routes, whose SDP API proxy is the fixtures.
 */

const harness = vi.hoisted(() => {
  const state = {
    now: new Date("2026-09-25T12:00:00.000Z"),
    unhandled: [] as string[],
  };
  type DemoBody = (path: string, now?: Date) => unknown;
  let demoBody: DemoBody | undefined;

  async function request(path: string, _init?: RequestInit): Promise<Response> {
    demoBody ??= (await import("./demo-fixtures")).paymentsDemoBody;
    const body = demoBody(path, state.now);
    if (body === undefined) {
      state.unhandled.push(path);
      return Response.json({ error: { message: `No demo body for ${path}` } }, { status: 404 });
    }
    return Response.json(body);
  }

  /** `SdpApiClient.fetch`: throws on a failed response and unwraps `data`. */
  async function fetchData<T>(path: string): Promise<T> {
    const response = await request(path);
    if (!response.ok) throw new Error(`SDP API request failed (${response.status})`);
    const json = (await response.json()) as { data: T };
    return json.data;
  }

  const trace = {
    traceId: "trace_demo",
    serverTiming: () => "",
    childContext: () => ({ traceId: "trace_demo", source: "demo-fixtures.test" }),
    step: <T>(_name: string, run: () => T) => run(),
    log: () => undefined,
  };

  return { state, request, apiClient: { request, fetch: fetchData }, trace };
});

vi.mock("@/lib/sdp-api", () => ({
  proxyToSdpApi: ({ path }: { path: string }) => harness.request(path),
  getSelectedProjectId: async () => "demo_prj",
  createSdpApiClient: async () => harness.apiClient,
}));
vi.mock("@/lib/request-tracing", () => ({
  createTimedTrace: () => harness.trace,
  logRouteResult: () => undefined,
}));
vi.mock("@/lib/dashboard-page-trace", () => ({
  withDashboardPageTrace: (_source: string, run: (context: unknown) => Promise<unknown>) =>
    run({ trace: harness.trace, apiClient: harness.apiClient }),
}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: "user_demo", orgId: "org_demo" }),
}));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
  getRequestLocale: async () => "en",
}));
vi.mock("@/lib/auth-entry", () => ({ getAuthEntryPath: async () => "/sign-in" }));
// The screens themselves are client components; the tests read the props the pages hand them.
vi.mock("@/app/dashboard/payments/counterparty/counterparty-workspace", () => ({
  CounterpartyWorkspace: () => null,
}));
vi.mock("@/app/dashboard/payments/counterparty/counterparty-detail-workspace", () => ({
  CounterpartyDetailWorkspace: () => null,
}));
vi.mock("@/app/dashboard/payments/requests/payment-requests-workspace", () => ({
  PaymentRequestsWorkspace: () => null,
}));
vi.mock("@/app/dashboard/payments/recurring/recurring-payments-workspace", () => ({
  RecurringPaymentsWorkspace: () => null,
}));
vi.mock("@/app/dashboard/payments/recurring/recurring-payment-detail-workspace", () => ({
  RecurringPaymentDetailWorkspace: () => null,
}));
vi.mock("@/app/dashboard/payments/transactions/transactions-workspace", () => ({
  TransactionsWorkspace: () => null,
}));

const NOW = harness.state.now;
const t = ((key: string) => key) as Parameters<typeof fetchRecurringPayments>[1];
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

type RouteHandler = (request: Request) => Promise<Response>;

const BFF_ROUTES: Record<string, RouteHandler> = {
  wallets: walletsGET,
  "wallets/aggregate": aggregateGET,
  "payments/transfers": transfersGET,
  "payments/transactions": transactionsGET,
  counterparty: counterpartiesGET,
  "counterparty/accounts": projectAccountsGET,
  "payments/recurring-payments": recurringPaymentsGET,
};

/** The browser's `fetch` of `/api/dashboard/...`, served by the real dashboard route handlers. */
async function dashboardRouteFetch(input: RequestInfo | URL, init?: RequestInit) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const request = new Request(new URL(href, "http://dashboard.test"), {
    method: init?.method ?? "GET",
    headers: init?.headers,
  });
  const route = new URL(request.url).pathname.split("/").filter(Boolean).slice(2);
  const handler = BFF_ROUTES[route.join("/")];
  if (handler) return handler(request);
  const [collection, second, id, child] = route;
  if (collection === "counterparty" && second && id === "accounts") {
    return counterpartyAccountsGET(request, {
      params: Promise.resolve({ counterpartyId: decodeURIComponent(second) }),
    });
  }
  if (collection === "counterparty" && second && id === "provider-accounts") {
    return providerAccountsGET(request, {
      params: Promise.resolve({ counterpartyId: decodeURIComponent(second) }),
    });
  }
  if (collection === "payments" && second === "recurring-payments" && id && !child) {
    return recurringPaymentGET(request, {
      params: Promise.resolve({ recurringPaymentId: decodeURIComponent(id) }),
    });
  }
  throw new Error(`No dashboard route for ${href}`);
}

function propsOf<T>(element: unknown): T {
  return (element as { props: T }).props;
}

function demoData<T>(path: string, now: Date = NOW): T {
  const body = paymentsDemoBody(path, now) as { data: T } | undefined;
  if (body === undefined) throw new Error(`No demo body for ${path}`);
  return body.data;
}

function demoContacts(): Counterparty[] {
  return demoData<ListCounterpartiesResponse>("/v1/counterparties?page=1&pageSize=100")
    .counterparties;
}

function demoSchedules(): PaymentRecurringPayment[] {
  return demoData<{ recurringPayments: PaymentRecurringPayment[] }>(
    "/v1/payments/recurring-payments?page=1&pageSize=100"
  ).recurringPayments;
}

function demoTransfers(query = "page=1&pageSize=100", now: Date = NOW): PaymentTransferSummary[] {
  return demoData<PaymentTransferSummary[]>(`/v1/payments/transfers?${query}`, now);
}

function isNewestFirst(rows: readonly { createdAt?: string }[]): boolean {
  return rows.every(
    (row, index) => index === 0 || (rows[index - 1]?.createdAt ?? "") >= (row.createdAt ?? "")
  );
}

beforeEach(() => {
  harness.state.now = NOW;
  harness.state.unhandled.length = 0;
  vi.stubGlobal("fetch", dashboardRouteFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Every read a covered screen makes must have a demo answer.
  expect(harness.state.unhandled).toEqual([]);
});

describe("paymentsDemoBody pass-through", () => {
  it.each([
    "/v1/projects",
    "/v1/onboarding/status",
    "/v1/organizations/org_1/provider-access",
    "/v1/organizations/org_1/members?page=1",
    "/v1/rpc/connections",
    "/v1/rpc/connections/rpc_1/usage",
    "/v1/api-keys",
    "/v1/policies",
    "/v1/counterparties/cpty_real",
    "/v1/counterparties/cpty_real/accounts?pageSize=100",
    "/v1/counterparties/metadata",
    "/v1/payments/transfers/xfr_real",
    "/v1/payments/transfer-batches/batch_real",
    "/v1/payments/recurring-payments/prp_real",
    "/v1/payments/subscriptions/sub_real/collection-attempts?page=1&pageSize=25",
    "/v1/wallets/cwlt_real",
    "/v1/issuance/tokens/tok_1",
    "/health",
  ])("lets %s through to the real API", (path) => {
    expect(paymentsDemoBody(path, NOW)).toBeUndefined();
  });
});

describe("demo world", () => {
  it("keeps every timestamp relative to now", () => {
    const later = new Date("2027-03-02T08:30:00.000Z");
    for (const now of [NOW, later]) {
      const [latest] = demoTransfers("page=1&pageSize=1", now);
      const latestAge = now.getTime() - Date.parse(latest?.createdAt ?? "");
      expect(latestAge).toBeGreaterThan(0);
      expect(latestAge).toBeLessThan(60 * 60_000);

      const schedules = demoData<{ recurringPayments: PaymentRecurringPayment[] }>(
        "/v1/payments/recurring-payments?status=active",
        now
      ).recurringPayments;
      for (const schedule of schedules) {
        expect(Date.parse(schedule.nextCollectionDueAt ?? "")).toBeGreaterThan(now.getTime());
      }
      const open = demoData<{ paymentRequests: PaymentRequest[] }>(
        "/v1/payments/requests?status=awaiting_payment",
        now
      ).paymentRequests;
      for (const request of open) {
        if (request.expiresAt !== null) {
          expect(Date.parse(request.expiresAt)).toBeGreaterThan(now.getTime());
        }
      }
    }
    // Recomputed per call, never cached across clocks: the same row shifts with `now`.
    const shift =
      Date.parse(demoTransfers("page=1&pageSize=1", later)[0]?.createdAt ?? "") -
      Date.parse(demoTransfers("page=1&pageSize=1", NOW)[0]?.createdAt ?? "");
    expect(shift).toBe(later.getTime() - NOW.getTime());
  });

  it("cross-references every id it hands out", () => {
    const walletIds = new Set(
      demoData<{ wallets: PaymentsDashboardWallet[] }>("/v1/wallets").wallets.map(
        (wallet) => wallet.id
      )
    );
    const contactIds = new Set(demoContacts().map((contact) => contact.id));
    const transfers = demoTransfers();
    const transferIds = new Set(transfers.map((transfer) => transfer.id));

    for (const transfer of transfers) {
      expect(transfer.id).toMatch(/^demo_/);
      expect(walletIds.has(transfer.custodyWalletId ?? "")).toBe(true);
      if (transfer.counterpartyId) expect(contactIds.has(transfer.counterpartyId)).toBe(true);
      if (transfer.signature) expect(transfer.signature).toMatch(BASE58_SIGNATURE);
      if (transfer.source) expect(transfer.source).toMatch(BASE58_ADDRESS);
      if (transfer.destination) expect(transfer.destination).toMatch(BASE58_ADDRESS);
      expect(paymentsDemoBody(`/v1/payments/transfers/${transfer.id}`, NOW)).toEqual({
        data: { transfer },
      });
    }

    for (const schedule of demoSchedules()) {
      expect(walletIds.has(schedule.sourceCustodyWalletId ?? "")).toBe(true);
      const accounts = demoData<{ accounts: CounterpartyAccount[] }>(
        `/v1/counterparties/${schedule.counterpartyId}/accounts?pageSize=100`
      ).accounts;
      expect(accounts.map((account) => account.id)).toContain(schedule.counterpartyAccountId);
      expect(accounts[0]?.details.address).toBe(schedule.destinationAddress);
      if (schedule.subscriptionId) {
        const attempts = demoData<{ collectionAttempts: PaymentSubscriptionCollectionAttempt[] }>(
          `/v1/payments/subscriptions/${schedule.subscriptionId}/collection-attempts?page=1&pageSize=25`
        ).collectionAttempts;
        for (const attempt of attempts) {
          if (attempt.transferId) expect(transferIds.has(attempt.transferId)).toBe(true);
        }
      }
    }

    for (const request of demoData<{ paymentRequests: PaymentRequest[] }>(
      "/v1/payments/requests?page=1&pageSize=100"
    ).paymentRequests) {
      if (request.fulfilledByTransferId) {
        const transfer = transfers.find(({ id }) => id === request.fulfilledByTransferId);
        expect(transfer?.amount).toBe(request.amount);
        expect(transfer?.kind).toBe("request_deposit");
      }
      if (request.counterpartyId) expect(contactIds.has(request.counterpartyId)).toBe(true);
      expect(request.reference).toMatch(BASE58_ADDRESS);
    }
  });
});

describe("Payments overview", () => {
  it("answers the balance with the sum of the wallets", async () => {
    const wallets = await fetchPaymentsWallets(harness.request, { includeBalances: true });
    expect(wallets.ok).toBe(true);
    expect(wallets.data?.map((wallet) => wallet.label)).toEqual([
      "Treasury",
      "Payroll",
      "Settlement",
    ]);
    for (const wallet of wallets.data ?? []) {
      expect(wallet.publicKey).toMatch(BASE58_ADDRESS);
      expect(wallet.balances?.length).toBeGreaterThan(0);
    }

    const aggregate = await fetchPaymentsAggregate(harness.request);
    expect(aggregate.ok).toBe(true);
    expect(aggregate.data?.walletCount).toBe(3);
    const walletSums = new Map<string, bigint>();
    for (const balance of (wallets.data ?? []).flatMap((wallet) => wallet.balances ?? [])) {
      walletSums.set(balance.mint, (walletSums.get(balance.mint) ?? 0n) + BigInt(balance.amount));
    }
    expect(
      new Map(aggregate.data?.balances.map((balance) => [balance.mint, BigInt(balance.amount)]))
    ).toEqual(walletSums);
    for (const balance of aggregate.data?.balances ?? []) {
      expect(WELL_KNOWN_TOKEN_BY_MINT.get(balance.mint)?.symbol).toBe(balance.token);
    }

    const balances = normalizeAggregateBalances(aggregate.data?.balances ?? []);
    expect(resolveTotalBalance(balances)).toBeGreaterThan(200_000);
    // Three or fewer balances keep the normalized order: USDC first, then by symbol.
    expect(selectTopAggregateBalanceRows(balances, {}).map((row) => row.token)).toEqual([
      "USDC",
      "EURC",
      "SOL",
    ]);
    expect(await fetchIssuedTokensByMint(harness.request)).toEqual({});
  });

  it("counts contacts, open requests and active schedules", async () => {
    const [contacts, requests, schedules] = await Promise.all([
      fetchCounterparties(harness.request, { page: 1, pageSize: 1 }),
      fetchPaymentRequests(harness.request, { pageSize: 1, status: "awaiting_payment" }),
      fetchRecurringPayments(harness.request, t, { page: 1, pageSize: 1, status: "active" }),
    ]);
    expect(contacts).toMatchObject({ ok: true, total: 7 });
    expect(contacts.data).toHaveLength(1);
    expect(requests).toMatchObject({ ok: true, total: 3 });
    expect(requests.data[0]?.status).toBe("awaiting_payment");
    expect(schedules.ok && schedules.data.total).toBe(2);
    expect(schedules.ok && schedules.data.recurringPayments).toHaveLength(1);
  });

  it("lists recent transfers and batches", async () => {
    const [transfers, batches, tokens, wallets] = await Promise.all([
      fetchPaymentTransfers(harness.request, 5, {
        includeObserved: false,
        types: ["transfer", "onramp", "offramp"],
      }),
      fetchTransferBatches(harness.request, 5),
      fetchPaymentsIssuedTokenSymbols(harness.request),
      fetchPaymentsWallets(harness.request, { view: "summary" }),
    ]);
    expect(transfers.ok).toBe(true);
    expect(transfers.data).toHaveLength(5);
    expect(isNewestFirst(transfers.data ?? [])).toBe(true);
    for (const transfer of transfers.data ?? []) {
      expect(["transfer", "onramp", "offramp"]).toContain(transfer.type);
    }
    expect(NOW.getTime() - Date.parse(transfers.data?.[0]?.createdAt ?? "")).toBeLessThan(
      60 * 60_000
    );
    expect(tokens).toEqual({ ok: true, data: [] });
    expect(wallets.ok).toBe(true);
    expect(wallets.data?.every((wallet) => wallet.balances === undefined)).toBe(true);

    expect(batches.ok).toBe(true);
    expect(batches.data).toHaveLength(2);
    const summaries = [];
    for (const batch of batches.data ?? []) {
      const recipients = await fetchTransferBatchRecipients(harness.request, batch.id);
      expect(recipients.ok).toBe(true);
      expect(recipients.data).toHaveLength(batch.recipientCount);
      summaries.push(summarizeBatch(batch, recipients.data).key);
    }
    expect(summaries).toEqual([
      "DashboardPayments.batchSummary.allSettled",
      "DashboardPayments.batchSummary.someFailed",
    ]);
  });

  it("merges persisted and observed transfers across wallets", async () => {
    const result = await fetchDashboardPaymentTransfers(harness.request, 20, {
      walletDeadlineMs: 2_500,
    });
    expect(result.ok).toBe(true);
    expect(result.walletsNotLoaded).toBe(0);
    expect(result.data).toHaveLength(20);
    expect(result.data?.some((transfer) => transfer.custodyWalletId === null)).toBe(true);
    expect(isNewestFirst(result.data ?? [])).toBe(true);
  });
});

describe("Transactions", () => {
  it("renders the page with varied rows tied to demo contacts and wallets", async () => {
    const props = propsOf<{
      initialResult: { transactions: UnifiedTransaction[]; nextCursor: string | null };
      wallets: { id: string }[];
      counterparties: { id: string; name: string }[];
    }>(await TransactionsPage({ searchParams: Promise.resolve({}) }));
    const rows = props.initialResult.transactions;
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(props.initialResult.nextCursor).toBeNull();
    expect(isNewestFirst(rows)).toBe(true);
    const contract = UNIFIED_TRANSACTION_MODULE_CONTRACTS.payments;
    const walletIds = props.wallets.map((wallet) => wallet.id);
    const contactIds = props.counterparties.map((contact) => contact.id);
    for (const row of rows) {
      expect(row.module).toBe("payments");
      expect(row.moduleId).toBe(row.id);
      expect(contract.kinds).toContain(row.kind);
      expect(contract.moduleStatuses).toContain(row.moduleStatus);
      expect(row.status).toBe(
        contract.status[row.moduleStatus as keyof typeof contract.status] ?? "missing"
      );
      expect(walletIds).toContain(row.custodyWalletId);
      expect(row.custodyWalletLabel).not.toBeNull();
      if (row.counterpartyId !== null) expect(contactIds).toContain(row.counterpartyId);
    }
    expect(new Set(rows.map((row) => row.kind))).toEqual(
      new Set([
        "pay",
        "deposit",
        "onramp",
        "offramp",
        "batch_pay",
        "recurring_pay",
        "request_deposit",
      ])
    );
    expect(new Set(rows.map((row) => row.status))).toEqual(
      new Set(["pending", "succeeded", "failed", "canceled"])
    );
  });

  it("pages with cursors and filters through the dashboard route", async () => {
    const filters = parseTransactionFilters({ pageSize: "10" });
    const first = await fetchTransactionsPageFromDashboard(transactionsApiQuery(filters));
    expect(first.transactions).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();
    const second = await fetchTransactionsPageFromDashboard(
      transactionsApiQuery({ ...filters, cursor: first.nextCursor ?? undefined })
    );
    expect(second.transactions).toHaveLength(10);
    const seen = new Set(first.transactions.map((row) => row.id));
    expect(second.transactions.some((row) => seen.has(row.id))).toBe(false);

    const [target] = first.transactions;
    const searched = await fetchTransactionsPageFromDashboard(
      transactionsApiQuery(parseTransactionFilters({ search: target?.id ?? "" }))
    );
    expect(searched.transactions.map((row) => row.id)).toEqual([target?.id]);

    const failed = await fetchTransactionsPageFromDashboard(
      transactionsApiQuery(parseTransactionFilters({ module: "payments", status: "failed" }))
    );
    expect(failed.transactions.length).toBeGreaterThan(0);
    expect(failed.transactions.every((row) => row.status === "failed")).toBe(true);

    const earn = await fetchTransactionsPageFromDashboard(
      transactionsApiQuery(parseTransactionFilters({ module: "earn" }))
    );
    expect(earn).toEqual({ transactions: [], nextCursor: null });
  });
});

describe("Contacts", () => {
  it("renders the list with every contact's saved address", async () => {
    const props = propsOf<{
      counterparties: Counterparty[];
      total: number;
      accounts: CounterpartyAccountSummary[];
      accountsTotal: number;
    }>(await CounterpartyPage({ searchParams: Promise.resolve({}) }));
    expect(props.total).toBe(7);
    expect(props.counterparties).toHaveLength(7);
    expect(props.accountsTotal).toBe(7);
    expect(new Set(props.accounts.map((account) => account.counterpartyId))).toEqual(
      new Set(props.counterparties.map((contact) => contact.id))
    );
    for (const account of props.accounts) expect(account.address).toMatch(BASE58_ADDRESS);
    expect(new Set(props.counterparties.map((contact) => contact.entityType))).toEqual(
      new Set(["business", "individual"])
    );
    expect(props.counterparties.filter((contact) => contact.externalId).length).toBeGreaterThan(1);
    expect(isNewestFirst(props.counterparties)).toBe(true);
  });

  it("pages the list", async () => {
    const page = await fetchCounterparties(harness.request, { page: 2, pageSize: 5 });
    expect(page).toMatchObject({ ok: true, total: 7 });
    expect(page.data).toHaveLength(2);
  });

  it.each(demoContacts().map((contact) => [contact.displayName, contact.id]))(
    "renders %s's detail with an account and transfers",
    async (_name, counterpartyId) => {
      const detail = propsOf<{ children: unknown }>(
        await CounterpartyDetailRoute({ params: Promise.resolve({ counterpartyId }) })
      );
      const props = propsOf<{
        counterparty: Counterparty;
        initialAccounts: CounterpartyAccount[];
        initialTransfers: PaymentTransferSummary[];
      }>(detail.children);
      expect(props.counterparty.id).toBe(counterpartyId);
      expect(props.initialAccounts).toHaveLength(1);
      expect(props.initialAccounts[0]?.details.address).toMatch(BASE58_ADDRESS);
      expect(props.initialTransfers.length).toBeGreaterThan(0);
      for (const transfer of props.initialTransfers) {
        expect(transfer.counterpartyId).toBe(counterpartyId);
        expect(typeof transfer.rampsMemo).toBe("object");
      }

      const providerAccounts = await dashboardFetch<{
        data: ListCounterpartyProviderAccountsResponse;
      }>(`/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/provider-accounts`);
      expect(providerAccounts.ok).toBe(true);
      const rows = providerAccounts.ok ? providerAccounts.data.data.accounts : [];
      // Jane Smith and Acme Logistics have a payout account; everyone else has none.
      expect(rows).toHaveLength(
        counterpartyId === "demo_cpty_jane" || counterpartyId === "demo_cpty_acme" ? 1 : 0
      );
      for (const row of rows) {
        expect(row).toMatchObject({ kind: "payout_account", status: "active" });
        expect(row.accountNumberLast4).toMatch(/^\d{4}$/);
      }
    }
  );
});

describe("Requests", () => {
  it("renders the list across every status, tied to demo wallets and contacts", async () => {
    const props = propsOf<{
      initialPaymentRequests: PaymentRequest[];
      total: number;
      initialError: string | undefined;
      wallets: PaymentsDashboardWallet[];
      counterparties: Counterparty[];
    }>(await PaymentRequestsPage({ searchParams: Promise.resolve({}) }));
    expect(props.initialError).toBeUndefined();
    expect(props.total).toBe(props.initialPaymentRequests.length);
    expect(props.initialPaymentRequests.length).toBeGreaterThanOrEqual(6);
    expect(new Set(props.initialPaymentRequests.map((request) => request.status))).toEqual(
      new Set(["awaiting_payment", "paid", "expired", "canceled"])
    );
    const walletIds = props.wallets.map((wallet) => wallet.walletId);
    const contactIds = props.counterparties.map((contact) => contact.id);
    for (const request of props.initialPaymentRequests) {
      expect(walletIds).toContain(request.walletId);
      if (request.counterpartyId) expect(contactIds).toContain(request.counterpartyId);
      expect(request.lifecycle[0]?.status).toBe("awaiting_payment");
    }
    expect(isNewestFirst(props.initialPaymentRequests)).toBe(true);
  });
});

describe("Schedules", () => {
  it("renders the list with every contact resolved", async () => {
    const props = propsOf<{ children: unknown }>(
      await RecurringPaymentsPage({ searchParams: Promise.resolve({}) })
    );
    const workspace = propsOf<{
      initialRecurringPayments: PaymentRecurringPayment[];
      total: number;
      wallets: PaymentsDashboardWallet[];
      counterparties: { id: string; displayName: string }[];
      lookupError: string | undefined;
    }>(props.children);
    expect(workspace.total).toBe(4);
    expect(workspace.lookupError).toBeUndefined();
    expect(workspace.counterparties).toHaveLength(4);
    expect(new Set(workspace.initialRecurringPayments.map((schedule) => schedule.status))).toEqual(
      new Set(["active", "pending_activation", "canceled"])
    );
    expect(
      new Set(workspace.initialRecurringPayments.map((schedule) => schedule.periodHours))
    ).toEqual(new Set([168, 720]));

    const active = propsOf<{ children: unknown }>(
      await RecurringPaymentsPage({ searchParams: Promise.resolve({ status: "active" }) })
    );
    expect(propsOf<{ total: number }>(active.children).total).toBe(2);
  });

  it.each(demoSchedules().map((schedule) => [schedule.id, schedule.status]))(
    "renders %s (%s) with its wallet, contact account and collection history",
    async (recurringPaymentId, status) => {
      const props = propsOf<{
        recurringPayment: PaymentRecurringPayment;
        wallet: PaymentsDashboardWallet | null;
        counterpartyAccounts: CounterpartyAccount[];
        counterpartyLabel: string;
        amountLabel: string;
        collectionAttempts: PaymentSubscriptionCollectionAttempt[];
        collectionAttemptsTotal: number;
        collectionAttemptsError: string | undefined;
      }>(await RecurringPaymentDetailRoute({ params: Promise.resolve({ recurringPaymentId }) }));
      const contact = await fetchCounterparty(
        harness.request,
        props.recurringPayment.counterpartyId
      );
      expect(props.recurringPayment.id).toBe(recurringPaymentId);
      expect(props.wallet?.id).toBe(props.recurringPayment.sourceCustodyWalletId);
      expect(props.counterpartyLabel).toBe(contact?.displayName);
      expect(props.counterpartyAccounts.map((account) => account.id)).toEqual([
        props.recurringPayment.counterpartyAccountId,
      ]);
      expect(props.amountLabel).toContain("USDC");
      expect(props.collectionAttemptsError).toBeUndefined();
      expect(props.collectionAttemptsTotal).toBe(props.collectionAttempts.length);
      if (status === "pending_activation") {
        expect(props.recurringPayment.subscriptionId).toBeNull();
        expect(props.collectionAttempts).toEqual([]);
      } else {
        expect(props.collectionAttempts.length).toBeGreaterThan(1);
      }
      if (status === "active") {
        expect(Date.parse(props.recurringPayment.nextCollectionDueAt ?? "")).toBeGreaterThan(
          NOW.getTime()
        );
      }
    }
  );

  it("shows a failed collection with a readable reason, then its retry", async () => {
    const weekly = demoSchedules().find((schedule) => schedule.periodHours === 168);
    const result = await fetchRecurringPaymentCollectionAttempts(
      harness.request,
      weekly?.subscriptionId ?? "",
      t
    );
    expect(result.ok).toBe(true);
    const attempts = result.ok ? result.data.collectionAttempts : [];
    const failed = attempts.find((attempt) => attempt.status === "failed");
    expect(failed?.error).toMatch(/balance too low/);
    expect(failed?.transferId).toBeNull();
    const retry = attempts.find((attempt) => attempt.metadata.source === "retry");
    expect(retry).toMatchObject({ status: "confirmed", metadata: { error: failed?.error } });
  });

  it("loads the client list and detail through the dashboard routes", async () => {
    const list = await listRecurringPayments({ page: 1, pageSize: 25, status: "active" }, t);
    expect(list.total).toBe(2);
    const [first] = list.recurringPayments;
    const detail = await getRecurringPayment(first?.id ?? "", undefined, t);
    expect(detail).toEqual(first);
  });
});

describe("Pay and Deposit", () => {
  it("offers wallets with balances and contacts with their accounts", async () => {
    const wallets = await fetchWallets({ includeBalances: true }, t);
    expect(wallets).toHaveLength(3);
    expect(wallets.every((wallet) => (wallet.balances?.length ?? 0) > 0)).toBe(true);
    expect((await fetchWalletAggregate(t)).walletCount).toBe(3);

    const contacts = await fetchAllCounterparties();
    expect(contacts.ok).toBe(true);
    expect(contacts.data).toHaveLength(7);
    for (const contact of contacts.data) {
      const accounts = await fetchCounterpartyAccounts(contact.id, t);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ accountKind: "crypto_wallet", status: "active" });
    }

    const recipients = await fetchBatchRecipients({ page: 1, pageSize: 25 }, t);
    expect(recipients.total).toBe(7);
    const kai = await fetchBatchRecipients({ page: 1, pageSize: 25, search: "kai" }, t);
    expect(kai.accounts.map((account) => account.name)).toEqual(["Kai Nakamura"]);
    const byId = await fetchBatchRecipients(
      { ids: [kai.accounts[0]?.counterpartyAccountId ?? ""] },
      t
    );
    expect(byId.accounts).toEqual(kai.accounts);
  });

  it("shows each wallet's recent inbound deposits, observed ones included", async () => {
    const wallets = await fetchWallets({ includeBalances: true }, t);
    for (const wallet of wallets) {
      const deposits = await fetchTransfers(
        { pageSize: 5, custodyWalletId: wallet.id, direction: "inbound", includeObserved: true },
        t
      );
      expect(deposits.length).toBeGreaterThan(0);
      expect(deposits.length).toBeLessThanOrEqual(5);
      expect(isNewestFirst(deposits)).toBe(true);
      for (const deposit of deposits) {
        expect(deposit.direction).toBe("inbound");
        expect(deposit.destination).toBe(wallet.publicKey);
      }
    }
    const treasury = await fetchTransfers(
      { pageSize: 5, custodyWalletId: wallets[0]?.id, direction: "inbound", includeObserved: true },
      t
    );
    expect(treasury).toHaveLength(5);
    expect(treasury.some((deposit) => deposit.custodyWalletId === null)).toBe(true);
    expect(treasury.some((deposit) => deposit.type === "onramp")).toBe(true);
  });

  it("merges every wallet's transfers when the route has no direct filter", async () => {
    const transfers = await fetchTransfers({ pageSize: 10 }, t);
    expect(transfers).toHaveLength(10);
    expect(isNewestFirst(transfers)).toBe(true);
  });
});
