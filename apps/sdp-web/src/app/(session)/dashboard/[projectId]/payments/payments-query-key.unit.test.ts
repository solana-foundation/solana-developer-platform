import { describe, expect, it } from "vitest";
import {
  type DashboardKeyScope,
  type DashboardRequestKey,
  dashboardRequestUrl,
} from "@/lib/dashboard-request-key";
import { SANDBOX_PROJECT } from "@/test/projects";
import {
  counterpartyReads,
  counterpartyRequirementsReads,
  isCounterpartyReadKey,
  moneyMovementReads,
  paymentRequestReads,
  paymentsQueryKeys,
  paymentTransferReads,
  type RequirementsCorridor,
  recurringPaymentReads,
  requirementsPollRequest,
} from "./payments-query-key";
import { sharedReadQueryKeys } from "./shared-reads-query-key";

const scope: DashboardKeyScope = { projectId: SANDBOX_PROJECT.id, mode: "demo" };
const corridor: RequirementsCorridor = {
  counterpartyId: "cpty_test",
  provider: "moonpay",
  direction: "onramp",
  assetRail: "usdc.solana",
  fiatCurrency: "USD",
  destinationCustodyWalletId: "cwlt_test",
};

const keys = {
  requestList: paymentsQueryKeys.paymentRequests(scope, { page: 2, pageSize: 25, status: null }),
  request: paymentsQueryKeys.paymentRequest(scope, "preq_test"),
  requestLink: paymentsQueryKeys.paymentRequestLink(scope, "preq_test"),
  members: paymentsQueryKeys.memberDirectory(scope),
  scheduleList: paymentsQueryKeys.recurringPayments(scope, {
    page: 1,
    pageSize: 25,
    status: "active",
  }),
  schedule: paymentsQueryKeys.recurringPayment(scope, "prp_test"),
  scheduleRuns: paymentsQueryKeys.recurringPaymentCollectionAttempts(scope, "prp/test"),
  recentTransfers: paymentsQueryKeys.recentTransfers(scope, {
    pageSize: 5,
    types: ["onramp", "offramp"],
  }),
  walletDeposits: paymentsQueryKeys.walletDeposits(scope, {
    custodyWalletId: "cwlt_test",
    pageSize: 5,
  }),
  payouts: paymentsQueryKeys.counterpartyPayouts(scope, {
    counterpartyId: "cpty_test",
    statuses: ["completed", "confirmed"],
  }),
  transfer: paymentsQueryKeys.transfer(scope, "xfr_test"),
  batches: paymentsQueryKeys.recentTransferBatches(scope, { pageSize: 5 }),
  batch: paymentsQueryKeys.transferBatch(scope, "batch_test"),
  transactions: paymentsQueryKeys.transactions(scope, { module: "payments", cursors: [] }),
  transactionLookup: paymentsQueryKeys.transactionLookup(scope, "xfr_test"),
  contactLookups: paymentsQueryKeys.counterpartyLookups(scope, ["cpty_b", "cpty_a", "cpty_b"]),
  contact: paymentsQueryKeys.counterparty(scope, "cpty_test"),
  contactAddresses: paymentsQueryKeys.counterpartyWalletAccounts(scope, "cpty_test"),
  requirements: paymentsQueryKeys.counterpartyRequirements(scope, corridor),
  requirementsPoll: paymentsQueryKeys.requirementsPoll(scope, corridor, "adv_test"),
  rampEstimate: paymentsQueryKeys.rampEstimate(scope, {
    direction: "offramp",
    fiatCurrency: "USD",
    assetRail: "usdc.solana",
    amount: "5",
  }),
  wallets: sharedReadQueryKeys.walletSummaries(scope, { includeBalances: true }),
} satisfies Record<string, DashboardRequestKey>;

function namesMatching(predicate: (key: DashboardRequestKey) => boolean): string[] {
  return Object.entries(keys)
    .filter(([, key]) => predicate(key))
    .map(([name]) => name);
}

describe("payments query keys", () => {
  it("keys every read under the tab's Project and mode", () => {
    for (const key of Object.values(keys)) {
      expect(key.slice(0, 2)).toEqual([SANDBOX_PROJECT.id, "demo"]);
    }
  });

  it("builds each list read's URL from its page, filters and paging", () => {
    expect(
      [
        keys.requestList,
        keys.scheduleList,
        keys.scheduleRuns,
        keys.recentTransfers,
        keys.walletDeposits,
        keys.batches,
        keys.transactions,
        keys.transactionLookup,
        keys.contactLookups,
      ].map(dashboardRequestUrl)
    ).toEqual([
      "/api/dashboard/payments/requests?page=2&pageSize=25",
      "/api/dashboard/payments/recurring-payments?page=1&pageSize=25&status=active",
      "/api/dashboard/payments/recurring-payments/prp%2Ftest/collection-attempts?page=1&pageSize=25",
      "/api/dashboard/payments/transfers?includeObserved=false&page=1&pageSize=5&type=onramp%2Cofframp",
      "/api/dashboard/payments/transfers?custodyWalletId=cwlt_test&direction=inbound&includeObserved=true&page=1&pageSize=5",
      "/api/dashboard/payments/transfers/batch?page=1&pageSize=5",
      "/api/dashboard/payments/transactions?limit=25&module=payments",
      "/api/dashboard/payments/transactions?limit=25&search=xfr_test",
      "/api/dashboard/counterparty?ids=cpty_a%2Ccpty_b",
    ]);
  });

  it("keeps the read bounds and the poll's advance in the key, apart from what is sent", () => {
    expect([keys.members, keys.payouts, keys.rampEstimate]).toEqual([
      [SANDBOX_PROJECT.id, "demo", "/api/dashboard/members", { pageSize: 100, cap: 1000 }],
      [
        SANDBOX_PROJECT.id,
        "demo",
        "/api/dashboard/payments/transfers",
        {
          counterpartyId: "cpty_test",
          direction: "outbound",
          status: "completed,confirmed",
          pageSize: 100,
          cap: 500,
        },
      ],
      [
        SANDBOX_PROJECT.id,
        "demo",
        "/api/dashboard/payments/ramps/offramp/estimate",
        {
          body: JSON.stringify({
            assetRail: "usdc.solana",
            fiatCurrency: "USD",
            cryptoAmount: "5",
          }),
        },
      ],
    ]);
    expect(keys.requirementsPoll).not.toEqual(keys.requirements);
    expect(requirementsPollRequest(keys.requirementsPoll)).toEqual(keys.requirements);
  });

  it("matches each write's reads and no others", () => {
    expect(namesMatching(paymentRequestReads)).toEqual(["requestList", "request", "requestLink"]);
    expect(namesMatching(recurringPaymentReads)).toEqual([
      "scheduleList",
      "schedule",
      "scheduleRuns",
    ]);
    expect(namesMatching(paymentTransferReads)).toEqual([
      "recentTransfers",
      "walletDeposits",
      "payouts",
      "transfer",
      "batches",
      "batch",
      "transactions",
      "transactionLookup",
    ]);
    expect(namesMatching(moneyMovementReads)).toEqual([
      ...namesMatching(paymentTransferReads),
      "wallets",
    ]);
    expect(namesMatching(counterpartyReads)).toEqual([
      "contactLookups",
      "contact",
      "contactAddresses",
      "requirements",
      "requirementsPoll",
    ]);
    expect(namesMatching(counterpartyRequirementsReads)).toEqual([
      "requirements",
      "requirementsPoll",
    ]);
    expect(isCounterpartyReadKey(paymentsQueryKeys.actionWallets())).toBe(false);
  });
});
