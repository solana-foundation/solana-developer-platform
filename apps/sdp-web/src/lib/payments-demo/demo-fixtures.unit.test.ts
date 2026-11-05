import type {
  Counterparty,
  CounterpartyAccount,
  ListCounterpartiesResponse,
} from "@sdp/types/counterparties";
import type {
  PaymentRecurringPayment,
  PaymentRequest,
  PaymentSubscriptionCollectionAttempt,
  PaymentsDashboardWallet,
  PaymentTransferSummary,
} from "@sdp/types/payments";
import { RAMP_PROVIDERS, type RampProviderId } from "@sdp/types/provider-access";
import {
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  UNIFIED_TRANSACTION_MODULES,
} from "@sdp/types/unified-transactions";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  counterpartiesPageResponseSchema,
  counterpartyAccountsResponseSchema,
  counterpartyProviderAccountsResponseSchema,
  counterpartyResponseSchema,
} from "@/app/(session)/dashboard/[projectId]/payments/counterparty/counterparty-read-schemas";
import {
  normalizeAggregateBalances,
  resolveTotalBalance,
  selectTopAggregateBalanceRows,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import {
  fetchDashboardPaymentTransfers,
  fetchIssuedTokensByMint,
  fetchPaymentsAggregate,
  fetchPaymentsIssuedTokenSymbols,
  fetchPaymentsWallets,
  fetchPaymentTransfers,
  paymentsWalletsResponseSchema,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-page.data";
import { summarizeBatch } from "@/app/(session)/dashboard/[projectId]/payments/payments-presentation";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import {
  projectCounterpartyAccountsResponseSchema,
  transferBatchListResponseSchema,
  transferBatchResponseSchema,
  transferListResponseSchema,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-read-schemas";
import { fetchBatchRecipients } from "@/app/(session)/dashboard/[projectId]/payments/payments-workspace.data";
import {
  collectionAttemptsEnvelopeSchema,
  recurringPaymentEnvelopeSchema,
  recurringPaymentsListEnvelopeSchema,
} from "@/app/(session)/dashboard/[projectId]/payments/recurring/recurring-payments.data";
import {
  paymentRequestDetailResponseSchema,
  paymentRequestsListResponseSchema,
} from "@/app/(session)/dashboard/[projectId]/payments/requests/payment-requests-page.data";
import { sharedReadQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads-query-key";
import { transactionsPageResponseSchema } from "@/app/(session)/dashboard/[projectId]/payments/transactions/transactions-page.data";
import { parseTransactionFilters } from "@/app/(session)/dashboard/[projectId]/payments/transactions/transactions-query";
import { GET as counterpartyAccountsGET } from "@/app/api/dashboard/counterparty/[counterpartyId]/accounts/route";
import { GET as providerAccountsGET } from "@/app/api/dashboard/counterparty/[counterpartyId]/provider-accounts/route";
import { GET as counterpartyGET } from "@/app/api/dashboard/counterparty/[counterpartyId]/route";
import { GET as projectAccountsGET } from "@/app/api/dashboard/counterparty/accounts/route";
import { GET as counterpartiesGET } from "@/app/api/dashboard/counterparty/route";
import { GET as collectionAttemptsGET } from "@/app/api/dashboard/payments/recurring-payments/[recurringPaymentId]/collection-attempts/route";
import { GET as recurringPaymentGET } from "@/app/api/dashboard/payments/recurring-payments/[recurringPaymentId]/route";
import { GET as recurringPaymentsGET } from "@/app/api/dashboard/payments/recurring-payments/route";
import { GET as paymentRequestGET } from "@/app/api/dashboard/payments/requests/[paymentRequestId]/route";
import { GET as paymentRequestsGET } from "@/app/api/dashboard/payments/requests/route";
import { GET as transactionsGET } from "@/app/api/dashboard/payments/transactions/route";
import { GET as transferBatchGET } from "@/app/api/dashboard/payments/transfers/batch/[batchId]/route";
import { GET as transferBatchesGET } from "@/app/api/dashboard/payments/transfers/batch/route";
import { GET as transfersGET } from "@/app/api/dashboard/payments/transfers/route";
import { GET as aggregateGET } from "@/app/api/dashboard/wallets/aggregate/route";
import { GET as walletsGET } from "@/app/api/dashboard/wallets/route";
import type { DashboardKeyScope } from "@/lib/dashboard-request-key";
import { readDashboardRequest } from "@/lib/dashboard-swr";
import { paymentsDemoBody } from "./demo-fixtures";

/*
 * Every demo body goes through the parsers the Payments screens use: the server data functions
 * read it through a fake `request` that answers from the fixtures, and the screens' reads reach it
 * through the real dashboard API routes, whose SDP API proxy is the fixtures.
 */

// The pages render on the new design, with the Demo switch on; the flags themselves read Vercel
// and the request.
// Every ramp provider on, as the flags leave them with all of them promoted.
vi.mock("@/flags/ramps", async () => {
  const { RAMP_PROVIDERS } = await import("@sdp/types/provider-access");
  return {
    getEnabledRampProviders: async () => RAMP_PROVIDERS,
    getOfferedRampProviders: async () => RAMP_PROVIDERS,
    isRampsEnabled: async () => true,
  };
});
// Every dashboard flag on, whichever ones the pages and getDashboardFlags read.
vi.mock(
  "@/flags",
  () =>
    new Proxy(
      {},
      {
        has: () => true,
        get: (_target, name) =>
          name === "then" || name === "__esModule" ? undefined : async () => true,
      }
    )
);

const harness = vi.hoisted(() => {
  const state = {
    now: new Date("2026-09-25T12:00:00.000Z"),
    unhandled: [] as string[],
  };
  type DemoBody = (path: string, rampProviders: readonly RampProviderId[], now?: Date) => unknown;
  let demoBody: DemoBody | undefined;

  async function request(path: string, _init?: RequestInit): Promise<Response> {
    demoBody ??= (await import("./demo-fixtures")).paymentsDemoBody;
    const body = demoBody(path, RAMP_PROVIDERS, state.now);
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
  auth: async () => ({ orgId: "org_demo" }),
}));
vi.mock("@/i18n/server", () => ({
  getTranslations: async () => (key: string) => key,
  getRequestLocale: async () => "en",
}));

const NOW = harness.state.now;
const t = ((key: string) => key) as Parameters<typeof fetchBatchRecipients>[1];
const DEMO: DashboardKeyScope = { projectId: "prj_test_sandbox", mode: "demo" };
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{86,88}$/;

type RouteHandler = (request: Request) => Promise<Response>;

const BFF_ROUTES: Record<string, RouteHandler> = {
  wallets: walletsGET,
  "wallets/aggregate": aggregateGET,
  "payments/transfers": transfersGET,
  "payments/transfers/batch": transferBatchesGET,
  "payments/transactions": transactionsGET,
  "payments/requests": paymentRequestsGET,
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
  const [collection, second, id, child] = route.map(decodeURIComponent);
  if (collection === "counterparty" && second && id === undefined) {
    return counterpartyGET(request, { params: Promise.resolve({ counterpartyId: second }) });
  }
  if (collection === "counterparty" && second && id === "accounts") {
    return counterpartyAccountsGET(request, {
      params: Promise.resolve({ counterpartyId: second }),
    });
  }
  if (collection === "counterparty" && second && id === "provider-accounts") {
    return providerAccountsGET(request, { params: Promise.resolve({ counterpartyId: second }) });
  }
  if (collection === "payments" && second === "requests" && id && !child) {
    return paymentRequestGET(request, { params: Promise.resolve({ paymentRequestId: id }) });
  }
  if (collection === "payments" && second === "transfers" && id === "batch" && child) {
    return transferBatchGET(request, { params: Promise.resolve({ batchId: child }) });
  }
  if (collection === "payments" && second === "recurring-payments" && id && !child) {
    return recurringPaymentGET(request, { params: Promise.resolve({ recurringPaymentId: id }) });
  }
  if (collection === "payments" && second === "recurring-payments" && id && child) {
    return collectionAttemptsGET(request, { params: Promise.resolve({ recurringPaymentId: id }) });
  }
  throw new Error(`No dashboard route for ${href}`);
}

function demoData<T>(path: string, now: Date = NOW): T {
  const body = paymentsDemoBody(path, RAMP_PROVIDERS, now) as { data: T } | undefined;
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
  // The client fetchers send the project in the tab's URL.
  vi.stubGlobal("window", { location: { pathname: "/dashboard/prj_test_sandbox/payments" } });
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
    "/v1/payments/recurring-payments/prp_real/collection-attempts?page=1&pageSize=25",
    "/v1/wallets/cwlt_real",
    "/v1/issuance/tokens/tok_1",
    "/health",
  ])("lets %s through to the real API", (path) => {
    expect(paymentsDemoBody(path, RAMP_PROVIDERS, NOW)).toBeUndefined();
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
      expect(
        paymentsDemoBody(`/v1/payments/transfers/${transfer.id}`, RAMP_PROVIDERS, NOW)
      ).toEqual({
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
      const attempts = demoData<{ collectionAttempts: PaymentSubscriptionCollectionAttempt[] }>(
        `/v1/payments/recurring-payments/${schedule.id}/collection-attempts?page=1&pageSize=25`
      ).collectionAttempts;
      for (const attempt of attempts) {
        if (attempt.transferId) expect(transferIds.has(attempt.transferId)).toBe(true);
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
      readDashboardRequest(
        sharedReadQueryKeys.counterparties(DEMO, { page: 1, pageSize: 1 }),
        counterpartiesPageResponseSchema
      ),
      readDashboardRequest(
        paymentsQueryKeys.paymentRequests(DEMO, {
          page: 1,
          pageSize: 1,
          status: "awaiting_payment",
        }),
        paymentRequestsListResponseSchema
      ),
      readDashboardRequest(
        paymentsQueryKeys.recurringPayments(DEMO, { page: 1, pageSize: 1, status: "active" }),
        recurringPaymentsListEnvelopeSchema
      ),
    ]);
    expect(contacts.data.total).toBe(7);
    expect(contacts.data.counterparties).toHaveLength(1);
    expect(requests.data.total).toBe(3);
    expect(requests.data.paymentRequests[0]?.status).toBe("awaiting_payment");
    expect(schedules.data.total).toBe(2);
    expect(schedules.data.recurringPayments).toHaveLength(1);
  });

  it("lists recent transfers and batches", async () => {
    const [transfers, tokens, wallets, batches] = await Promise.all([
      fetchPaymentTransfers(harness.request, 5, {
        includeObserved: false,
        types: ["transfer", "onramp", "offramp"],
      }),
      fetchPaymentsIssuedTokenSymbols(harness.request),
      fetchPaymentsWallets(harness.request, { view: "summary" }),
      readDashboardRequest(
        paymentsQueryKeys.recentTransferBatches(DEMO, { pageSize: 5 }),
        transferBatchListResponseSchema
      ),
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

    expect(batches.data).toHaveLength(2);
    const summaries = [];
    for (const batch of batches.data) {
      const detail = await readDashboardRequest(
        paymentsQueryKeys.transferBatch(DEMO, batch.id),
        transferBatchResponseSchema
      );
      expect(detail.data.recipients).toHaveLength(batch.recipientCount);
      summaries.push(summarizeBatch(batch, detail.data.recipients).key);
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
  const filters = parseTransactionFilters({}, UNIFIED_TRANSACTION_MODULES);

  it("lists varied rows tied to demo contacts and wallets", async () => {
    const [page, wallets, contacts] = await Promise.all([
      readDashboardRequest(
        paymentsQueryKeys.transactions(DEMO, filters),
        transactionsPageResponseSchema
      ),
      readDashboardRequest(
        sharedReadQueryKeys.walletSummaries(DEMO, { includeBalances: false }),
        paymentsWalletsResponseSchema
      ),
      readDashboardRequest(
        sharedReadQueryKeys.counterparties(DEMO, { page: 1, pageSize: 100 }),
        counterpartiesPageResponseSchema
      ),
    ]);
    const rows = page.data.transactions;
    expect(rows.length).toBeGreaterThanOrEqual(16);
    expect(page.data.nextCursor).toBeNull();
    expect(isNewestFirst(rows)).toBe(true);
    const contract = UNIFIED_TRANSACTION_MODULE_CONTRACTS.payments;
    const walletIds = wallets.data.wallets.map((wallet) => wallet.id);
    const contactIds = contacts.data.counterparties.map((contact) => contact.id);
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
    const readPage = async (query: Record<string, string>) =>
      (
        await readDashboardRequest(
          paymentsQueryKeys.transactions(
            DEMO,
            parseTransactionFilters(query, UNIFIED_TRANSACTION_MODULES)
          ),
          transactionsPageResponseSchema
        )
      ).data;
    const first = await readPage({ pageSize: "10" });
    expect(first.transactions).toHaveLength(10);
    expect(first.nextCursor).not.toBeNull();
    const second = await readPage({ pageSize: "10", cursor: first.nextCursor ?? "" });
    expect(second.transactions).toHaveLength(10);
    const seen = new Set(first.transactions.map((row) => row.id));
    expect(second.transactions.some((row) => seen.has(row.id))).toBe(false);

    const [target] = first.transactions;
    const searched = await readPage({ search: target?.id ?? "" });
    expect(searched.transactions.map((row) => row.id)).toEqual([target?.id]);

    const failed = await readPage({ module: "payments", status: "failed" });
    expect(failed.transactions.length).toBeGreaterThan(0);
    expect(failed.transactions.every((row) => row.status === "failed")).toBe(true);

    expect(await readPage({ module: "earn" })).toEqual({ transactions: [], nextCursor: null });
  });
});

describe("Contacts", () => {
  it("lists every contact with its saved address", async () => {
    const [contacts, addresses] = await Promise.all([
      readDashboardRequest(
        sharedReadQueryKeys.counterparties(DEMO, { page: 1, pageSize: 100 }),
        counterpartiesPageResponseSchema
      ),
      readDashboardRequest(
        paymentsQueryKeys.projectCounterpartyAccounts(DEMO, { page: 1, pageSize: 100 }),
        projectCounterpartyAccountsResponseSchema
      ),
    ]);
    const { counterparties, total } = contacts.data;
    expect(total).toBe(7);
    expect(counterparties).toHaveLength(7);
    expect(addresses.data.total).toBe(7);
    expect(new Set(addresses.data.accounts.map((account) => account.counterpartyId))).toEqual(
      new Set(counterparties.map((contact) => contact.id))
    );
    for (const account of addresses.data.accounts) expect(account.address).toMatch(BASE58_ADDRESS);
    expect(new Set(counterparties.map((contact) => contact.entityType))).toEqual(
      new Set(["business", "individual"])
    );
    expect(counterparties.filter((contact) => contact.externalId).length).toBeGreaterThan(1);
    expect(isNewestFirst(counterparties)).toBe(true);
  });

  it("pages the list", async () => {
    const page = await readDashboardRequest(
      sharedReadQueryKeys.counterparties(DEMO, { page: 2, pageSize: 5 }),
      counterpartiesPageResponseSchema
    );
    expect(page.data.total).toBe(7);
    expect(page.data.counterparties).toHaveLength(2);
  });

  it.each(demoContacts().map((contact) => [contact.displayName, contact.id]))(
    "reads %s's detail with an account and transfers",
    async (_name, counterpartyId) => {
      const [contact, accounts, transfers, providerAccounts] = await Promise.all([
        readDashboardRequest(
          paymentsQueryKeys.counterparty(DEMO, counterpartyId),
          counterpartyResponseSchema
        ),
        readDashboardRequest(
          paymentsQueryKeys.counterpartyAccounts(DEMO, counterpartyId),
          counterpartyAccountsResponseSchema
        ),
        readDashboardRequest(
          paymentsQueryKeys.counterpartyTransfers(DEMO, { counterpartyId, pageSize: 25 }),
          transferListResponseSchema
        ),
        readDashboardRequest(
          paymentsQueryKeys.counterpartyProviderAccounts(DEMO, counterpartyId),
          counterpartyProviderAccountsResponseSchema
        ),
      ]);
      expect(contact.data.counterparty.id).toBe(counterpartyId);
      expect(accounts.data.accounts).toHaveLength(1);
      expect(accounts.data.accounts[0]?.details.address).toMatch(BASE58_ADDRESS);
      expect(transfers.data.length).toBeGreaterThan(0);
      for (const transfer of transfers.data) {
        expect(transfer.counterpartyId).toBe(counterpartyId);
      }
      expect(providerAccounts.data.accounts).toEqual([]);
    }
  );
});

describe("Requests", () => {
  it("lists every status, and opens each request on a demo wallet", async () => {
    const [list, wallets] = await Promise.all([
      readDashboardRequest(
        paymentsQueryKeys.paymentRequests(DEMO, { page: 1, pageSize: 100, status: null }),
        paymentRequestsListResponseSchema
      ),
      readDashboardRequest(
        sharedReadQueryKeys.walletSummaries(DEMO, { includeBalances: false }),
        paymentsWalletsResponseSchema
      ),
    ]);
    const requests = list.data.paymentRequests;
    expect(list.data.total).toBe(requests.length);
    expect(requests.length).toBeGreaterThanOrEqual(6);
    expect(new Set(requests.map((request) => request.status))).toEqual(
      new Set(["awaiting_payment", "paid", "expired", "canceled"])
    );
    expect(isNewestFirst(requests)).toBe(true);
    const walletIds = wallets.data.wallets.map((wallet) => wallet.id);
    for (const request of requests) {
      expect(request.lifecycle[0]?.status).toBe("awaiting_payment");
      const detail = await readDashboardRequest(
        paymentsQueryKeys.paymentRequest(DEMO, request.id),
        paymentRequestDetailResponseSchema
      );
      expect(detail.data.id).toBe(request.id);
      expect(walletIds).toContain(detail.data.walletId);
    }
  });
});

describe("Schedules", () => {
  it("lists every schedule with its contact", async () => {
    const list = await readDashboardRequest(
      paymentsQueryKeys.recurringPayments(DEMO, { page: 1, pageSize: 25, status: null }),
      recurringPaymentsListEnvelopeSchema
    );
    const schedules = list.data.recurringPayments;
    expect(list.data.total).toBe(4);
    expect(new Set(schedules.map((schedule) => schedule.status))).toEqual(
      new Set(["active", "pending_activation", "canceled"])
    );
    expect(new Set(schedules.map((schedule) => schedule.periodHours))).toEqual(new Set([168, 720]));
    for (const counterpartyId of new Set(schedules.map((schedule) => schedule.counterpartyId))) {
      const contact = await readDashboardRequest(
        paymentsQueryKeys.counterparty(DEMO, counterpartyId),
        counterpartyResponseSchema
      );
      expect(contact.data.counterparty.id).toBe(counterpartyId);
    }
  });

  it.each(demoSchedules().map((schedule) => [schedule.id, schedule.status]))(
    "reads %s (%s) with its wallet, contact account and collection history",
    async (recurringPaymentId, status) => {
      const [schedule, wallets, attempts] = await Promise.all([
        readDashboardRequest(
          paymentsQueryKeys.recurringPayment(DEMO, recurringPaymentId),
          recurringPaymentEnvelopeSchema
        ),
        readDashboardRequest(
          sharedReadQueryKeys.walletSummaries(DEMO, { includeBalances: true }),
          paymentsWalletsResponseSchema
        ),
        readDashboardRequest(
          paymentsQueryKeys.recurringPaymentCollectionAttempts(DEMO, recurringPaymentId),
          collectionAttemptsEnvelopeSchema
        ),
      ]);
      const { recurringPayment } = schedule.data;
      const accounts = await readDashboardRequest(
        paymentsQueryKeys.counterpartyAccounts(DEMO, recurringPayment.counterpartyId),
        counterpartyAccountsResponseSchema
      );
      expect(recurringPayment.id).toBe(recurringPaymentId);
      expect(wallets.data.wallets.map((wallet) => wallet.id)).toContain(
        recurringPayment.sourceCustodyWalletId
      );
      expect(accounts.data.accounts.map((account) => account.id)).toEqual([
        recurringPayment.counterpartyAccountId,
      ]);
      expect(WELL_KNOWN_TOKEN_BY_MINT.get(recurringPayment.token)?.symbol).toBe("USDC");
      const { collectionAttempts, total } = attempts.data;
      expect(total).toBe(collectionAttempts.length);
      if (status === "pending_activation") {
        expect(recurringPayment.subscriptionId).toBeNull();
        expect(collectionAttempts).toEqual([]);
      } else {
        expect(collectionAttempts.length).toBeGreaterThan(1);
      }
      if (status === "active") {
        expect(Date.parse(recurringPayment.nextCollectionDueAt ?? "")).toBeGreaterThan(
          NOW.getTime()
        );
      }
    }
  );

  it("shows a failed collection with a readable reason, then its retry", async () => {
    const attempts = await readDashboardRequest(
      paymentsQueryKeys.recurringPaymentCollectionAttempts(DEMO, "demo_rp_kai_weekly"),
      collectionAttemptsEnvelopeSchema
    );
    const { collectionAttempts } = attempts.data;
    const failed = collectionAttempts.find((attempt) => attempt.status === "failed");
    expect(failed?.error).toMatch(/balance too low/);
    expect(failed?.transferId).toBeNull();
    const retry = collectionAttempts.find((attempt) => attempt.metadata.source === "retry");
    expect(retry).toMatchObject({ status: "confirmed", metadata: { error: failed?.error } });
  });
});

describe("Pay and Deposit", () => {
  it("offers wallets with balances and contacts with their accounts", async () => {
    const wallets = await readDashboardRequest(
      sharedReadQueryKeys.walletSummaries(DEMO, { includeBalances: true }),
      paymentsWalletsResponseSchema
    );
    expect(wallets.data.wallets).toHaveLength(3);
    expect(wallets.data.wallets.every((wallet) => (wallet.balances?.length ?? 0) > 0)).toBe(true);

    const contacts = await readDashboardRequest(
      paymentsQueryKeys.allCounterparties(DEMO),
      counterpartiesPageResponseSchema
    );
    expect(contacts.data.counterparties).toHaveLength(7);
    for (const contact of contacts.data.counterparties) {
      const accounts = await readDashboardRequest(
        paymentsQueryKeys.counterpartyAccounts(DEMO, contact.id),
        counterpartyAccountsResponseSchema
      );
      expect(accounts.data.accounts).toHaveLength(1);
      expect(accounts.data.accounts[0]).toMatchObject({
        accountKind: "crypto_wallet",
        status: "active",
      });
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
    const wallets = await readDashboardRequest(
      sharedReadQueryKeys.walletSummaries(DEMO, { includeBalances: true }),
      paymentsWalletsResponseSchema
    );
    const depositsOf = async (custodyWalletId: string) =>
      (
        await readDashboardRequest(
          paymentsQueryKeys.walletDeposits(DEMO, { custodyWalletId, pageSize: 5 }),
          transferListResponseSchema
        )
      ).data;
    for (const wallet of wallets.data.wallets) {
      const deposits = await depositsOf(wallet.id);
      expect(deposits.length).toBeGreaterThan(0);
      expect(deposits.length).toBeLessThanOrEqual(5);
      expect(isNewestFirst(deposits)).toBe(true);
      for (const deposit of deposits) {
        expect(deposit.direction).toBe("inbound");
        expect(deposit.destination).toBe(wallet.publicKey);
      }
    }
    const treasury = await depositsOf(wallets.data.wallets[0]?.id ?? "");
    expect(treasury).toHaveLength(5);
    expect(treasury.some((deposit) => deposit.custodyWalletId === null)).toBe(true);
  });

  it("merges every wallet's transfers when the route has no direct filter", async () => {
    const transfers = await readDashboardRequest(
      paymentsQueryKeys.dashboardTransfers(DEMO, { pageSize: 10 }),
      transferListResponseSchema
    );
    expect(transfers.data).toHaveLength(10);
    expect(isNewestFirst(transfers.data)).toBe(true);
  });
});
