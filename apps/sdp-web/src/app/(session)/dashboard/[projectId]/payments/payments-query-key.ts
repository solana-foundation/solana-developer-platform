import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CryptoRailId } from "@sdp/types/payment-rails";
import type {
  PaymentRecurringPaymentStatus,
  PaymentRequestStatus,
  PaymentTransferType,
  RampDirection,
} from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { Arguments } from "swr";
import {
  DEFAULT_TRANSACTION_PAGE_SIZE,
  type TransactionFilters,
  toTransactionsApiQuery,
} from "@/app/(session)/dashboard/[projectId]/payments/transactions/transactions-query";
import {
  type DashboardJsonValue,
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardPostReadKey,
  dashboardRequestKey,
  isDashboardRequestKey,
  readsUnderPath,
} from "@/lib/dashboard-request-key";

export interface CounterpartyRequirementsParams {
  counterpartyId: string;
  provider: RampProviderId | null;
  direction: RampDirection;
  assetRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
  /** Onramp only: the destination custody wallet the quote pays into. null until selected. */
  destinationCustodyWalletId: string | null;
}

/** Every read a payment request write changes: the requests list, its counts and each request. */
export const paymentRequestReads = readsUnderPath("/api/dashboard/payments/requests");

/** Every read a transfer or batch write changes: transfer lists, a transfer, batches. */
export const paymentTransferReads = (key: DashboardRequestKey) =>
  readsUnderPath("/api/dashboard/payments/transfers")(key) ||
  readsUnderPath("/api/dashboard/payments/transactions")(key);

/** Every read money leaving or reaching a wallet changes: transfers, batches and balances. */
export const moneyMovementReads = (key: DashboardRequestKey) =>
  paymentTransferReads(key) ||
  readsUnderPath("/api/dashboard/wallets")(key) ||
  readsUnderPath("/api/dashboard/payments/wallets")(key);

/** Every read a schedule write changes: the schedules list, its counts and each schedule. */
export const recurringPaymentReads = readsUnderPath("/api/dashboard/payments/recurring-payments");

/** Every contact read: the directories, a contact, its accounts and provider accounts. */
export const counterpartyReads = readsUnderPath("/api/dashboard/counterparty");

/** {@link counterpartyReads} for an SWR filter, which hands it every key in the cache. */
export const isCounterpartyReadKey = (key: Arguments) =>
  isDashboardRequestKey(key) && counterpartyReads(key);

const COUNTERPARTY_ACCOUNTS_PAGE_SIZE = 100;

/** One requirements corridor: the contact, the provider and direction, and what moves. */
export interface RequirementsCorridor {
  counterpartyId: string;
  provider: RampProviderId;
  direction: RampDirection;
  assetRail: CryptoRailId;
  fiatCurrency: RampFiatCurrency;
  /** Onramp only: the custody wallet the quote pays into. */
  destinationCustodyWalletId: string;
}

function requirementsPath(counterpartyId: string): `/api/${string}` {
  return `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/requirements`;
}

function requirementsQuery(corridor: RequirementsCorridor) {
  return {
    provider: corridor.provider,
    direction: corridor.direction,
    assetRail: corridor.assetRail,
    fiatCurrency: corridor.fiatCurrency,
    destinationCustodyWalletId:
      corridor.direction === "onramp" ? corridor.destinationCustodyWalletId : undefined,
  };
}

/** The request a requirements poll key sends: the key without its `advanceId`. */
export function requirementsPollRequest(key: DashboardRequestKey): DashboardRequestKey {
  // The advance id only keys the cache entry; the API's strict query refuses it, so it is not sent.
  const { advanceId: _advanceId, ...query } = key[3] ?? {};
  return dashboardRequestKey({ projectId: key[0], mode: key[1] }, key[2], query);
}

/** Every requirements read, the poll included: a provider pick reads them all again. */
export const counterpartyRequirementsReads = (key: DashboardRequestKey) =>
  /^\/api\/dashboard\/counterparty\/[^/]+\/requirements$/.test(key[2]);

export const paymentsQueryKeys = {
  paymentRequests: (
    scope: DashboardKeyScope,
    list: { page: number; pageSize: number; status: PaymentRequestStatus | null }
  ) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/requests", {
      page: list.page,
      pageSize: list.pageSize,
      status: list.status ?? undefined,
    }),
  paymentRequestLink: (scope: DashboardKeyScope, requestId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/payments/requests/${encodeURIComponent(requestId)}/link`
    ),
  /** The organization's members up to `cap` (not sent), for naming who canceled a request. */
  memberDirectory: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/members", { pageSize: 100, cap: 1000 }),
  paymentRequest: (scope: DashboardKeyScope, requestId: string) =>
    dashboardRequestKey(scope, `/api/dashboard/payments/requests/${encodeURIComponent(requestId)}`),
  recurringPayments: (
    scope: DashboardKeyScope,
    list: {
      page: number;
      pageSize: number;
      status: PaymentRecurringPaymentStatus | null;
      counterpartyId?: string;
    }
  ) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/recurring-payments", {
      page: list.page,
      pageSize: list.pageSize,
      status: list.status ?? undefined,
      counterpartyId: list.counterpartyId,
    }),
  recurringPayment: (scope: DashboardKeyScope, recurringPaymentId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}`
    ),
  recurringPaymentCollectionAttempts: (scope: DashboardKeyScope, recurringPaymentId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/payments/recurring-payments/${encodeURIComponent(recurringPaymentId)}/collection-attempts`,
      { page: 1, pageSize: 25 }
    ),
  recentTransfers: (
    scope: DashboardKeyScope,
    options: { pageSize: number; types: readonly PaymentTransferType[] }
  ) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/transfers", {
      page: 1,
      pageSize: options.pageSize,
      type: options.types.join(","),
      includeObserved: "false",
    }),
  dashboardTransfers: (scope: DashboardKeyScope, options: { pageSize: number }) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/transfers", options),
  walletDeposits: (
    scope: DashboardKeyScope,
    options: { custodyWalletId: string; pageSize: number }
  ) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/transfers", {
      page: 1,
      pageSize: options.pageSize,
      custodyWalletId: options.custodyWalletId,
      direction: "inbound",
      includeObserved: "true",
    }),
  counterpartyTransfers: (
    scope: DashboardKeyScope,
    options: { counterpartyId: string; pageSize: number }
  ) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/transfers", {
      page: 1,
      pageSize: options.pageSize,
      counterpartyId: options.counterpartyId,
    }),
  /** A contact's settled payouts, newest first, up to `cap`, read in pages under one entry. */
  counterpartyPayouts: (
    scope: DashboardKeyScope,
    options: { counterpartyId: string; statuses: readonly string[] }
  ) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/transfers", {
      counterpartyId: options.counterpartyId,
      direction: "outbound",
      status: options.statuses.join(","),
      pageSize: 100,
      cap: 500,
    }),
  transfer: (scope: DashboardKeyScope, transferId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/payments/transfers/${encodeURIComponent(transferId)}`
    ),
  recentTransferBatches: (scope: DashboardKeyScope, options: { pageSize: number }) =>
    dashboardRequestKey(scope, "/api/dashboard/payments/transfers/batch", {
      page: 1,
      pageSize: options.pageSize,
    }),
  transferBatch: (scope: DashboardKeyScope, batchId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/payments/transfers/batch/${encodeURIComponent(batchId)}`
    ),
  transactions: (scope: DashboardKeyScope, filters: TransactionFilters) =>
    dashboardRequestKey(
      scope,
      "/api/dashboard/payments/transactions",
      Object.fromEntries(
        toTransactionsApiQuery(filters, filters.pageSize ?? DEFAULT_TRANSACTION_PAGE_SIZE)
      )
    ),
  transactionLookup: (scope: DashboardKeyScope, transactionId: string) =>
    // The ledger's search matches an id as a prefix, so a whole id finds itself on the first
    // page; the page is only there for a module id or signature that happens to share it.
    dashboardRequestKey(scope, "/api/dashboard/payments/transactions", {
      search: transactionId,
      limit: String(DEFAULT_TRANSACTION_PAGE_SIZE),
    }),
  /** Every contact, one page at a time under one entry; the first request is page 1. */
  allCounterparties: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty", { pageSize: 100 }),
  /** Each contact in `counterpartyIds`, one request per contact, under a single entry. */
  counterpartyLookups: (scope: DashboardKeyScope, counterpartyIds: readonly string[]) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty", {
      ids: [...new Set(counterpartyIds)].sort().join(","),
    }),
  /** The Contact list's directory: every contact up to `cap`, read in pages under one entry. */
  counterpartyDirectory: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty", { pageSize: 100, cap: 500 }),
  /** Every saved Solana address across the Project's contacts, up to `cap`, under one entry. */
  counterpartyAddressDirectory: (scope: DashboardKeyScope) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty/accounts", {
      pageSize: 100,
      cap: 1000,
    }),
  counterparty: (scope: DashboardKeyScope, counterpartyId: string) =>
    dashboardRequestKey(scope, `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}`),
  counterpartyAccounts: (scope: DashboardKeyScope, counterpartyId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/accounts`,
      { pageSize: COUNTERPARTY_ACCOUNTS_PAGE_SIZE }
    ),
  /** Every Solana address a contact holds, one page at a time under one entry. */
  counterpartyWalletAccounts: (scope: DashboardKeyScope, counterpartyId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/accounts`,
      { accountKind: "crypto_wallet", pageSize: COUNTERPARTY_ACCOUNTS_PAGE_SIZE }
    ),
  counterpartyProviderAccounts: (scope: DashboardKeyScope, counterpartyId: string) =>
    dashboardRequestKey(
      scope,
      `/api/dashboard/counterparty/${encodeURIComponent(counterpartyId)}/provider-accounts`
    ),
  projectCounterpartyAccounts: (
    scope: DashboardKeyScope,
    options: { page: number; pageSize?: number; search?: string }
  ) =>
    dashboardRequestKey(scope, "/api/dashboard/counterparty/accounts", {
      page: options.page,
      pageSize: options.pageSize,
      search: options.search === "" ? undefined : options.search,
    }),
  /** The wallets module reads this inventory key; Payments reads wallets through the shared reads. */
  actionWallets: () => "payments-action-wallets",
  /** A transfer write's mutation state (`useSWRMutation`), not a read. */
  createTransfer: () => "payments-create-transfer",
  counterpartyRequirements: (scope: DashboardKeyScope, corridor: RequirementsCorridor) =>
    dashboardRequestKey(
      scope,
      requirementsPath(corridor.counterpartyId),
      requirementsQuery(corridor)
    ),
  /**
   * The onboarding poll after one advance. `advanceId` is never sent: it only keeps two advances
   * from sharing an entry, since a tick in flight for an older advance would otherwise land in
   * the newer one's. The request is {@link paymentsQueryKeys.counterpartyRequirements}'s.
   */
  requirementsPoll: (scope: DashboardKeyScope, corridor: RequirementsCorridor, advanceId: string) =>
    dashboardRequestKey(scope, requirementsPath(corridor.counterpartyId), {
      ...requirementsQuery(corridor),
      advanceId,
    }),
  /** A ramp estimate: a POST read keyed by its body (`readDashboardPostRequest`). */
  rampEstimate: (
    scope: DashboardKeyScope,
    estimate: {
      direction: RampDirection;
      fiatCurrency: RampFiatCurrency;
      assetRail: CryptoRailId;
      amount: string;
    }
  ) =>
    dashboardPostReadKey(scope, `/api/dashboard/payments/ramps/${estimate.direction}/estimate`, {
      assetRail: estimate.assetRail,
      fiatCurrency: estimate.fiatCurrency,
      [estimate.direction === "onramp" ? "fiatAmount" : "cryptoAmount"]: estimate.amount,
    }),
  /** A batch fee estimate: a POST read keyed by its body (`readDashboardPostRequest`). */
  batchEstimate: (
    scope: DashboardKeyScope,
    body: { readonly [field: string]: DashboardJsonValue }
  ) => dashboardPostReadKey(scope, "/api/dashboard/payments/transfers/batch/estimate", body),
};

/**
 * The requirements read's key, or null (nothing read) until a provider, a contact and, for an
 * onramp, a destination custody wallet are all chosen.
 */
export function buildCounterpartyRequirementsKey(
  scope: DashboardKeyScope,
  params: CounterpartyRequirementsParams | null
) {
  if (params === null || params.provider === null || params.counterpartyId === "") {
    return null;
  }
  const destinationCustodyWalletId =
    params.direction === "offramp" ? "" : params.destinationCustodyWalletId;
  if (destinationCustodyWalletId === null) {
    return null;
  }
  return paymentsQueryKeys.counterpartyRequirements(scope, {
    counterpartyId: params.counterpartyId,
    provider: params.provider,
    direction: params.direction,
    assetRail: params.assetRail,
    fiatCurrency: params.fiatCurrency,
    destinationCustodyWalletId,
  });
}
