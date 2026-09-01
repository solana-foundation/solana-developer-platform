import { describe, expect, it } from "vitest";
import { custodyQueryKeys } from "./custody/custody-query-key";
import { DEFAULT_ISSUANCE_LIST_QUERY } from "./issuance/issuance-list-query";
import { issuanceQueryKeys } from "./issuance/issuance-query-key";
import { earnQueryKeys } from "./markets/earn/earn-query-key";
import { paymentsQueryKeys } from "./payments/payments-query-key";

const plainKeys = [
  paymentsQueryKeys.actionCounterparties(),
  paymentsQueryKeys.actionWallets(),
  paymentsQueryKeys.counterpartyFieldOptions(),
  custodyQueryKeys.policyDestinationAccounts(),
  issuanceQueryKeys.createTokenSignerWallets(),
  earnQueryKeys.programs(),
  earnQueryKeys.vaultPositions(),
  earnQueryKeys.vaultDepositsInFlight(),
  earnQueryKeys.vaultWithdrawalsInFlight(),
  earnQueryKeys.fundingWallets(),
];

const parameterizedKeys: [key: readonly unknown[], params: unknown[]][] = [
  [paymentsQueryKeys.onrampTransferStatus({ transferId: "tr_1" }), ["tr_1"]],
  [paymentsQueryKeys.offrampTransferStatus({ transferId: "tr_2" }), ["tr_2"]],
  [paymentsQueryKeys.requirementsStatusPoll({ subjectKey: "subject_1" }), ["subject_1"]],
  [
    paymentsQueryKeys.rampEstimate({
      direction: "onramp",
      fiatCurrency: "USD",
      assetRail: "usdc.solana",
      amount: "25.00",
    }),
    ["onramp", "USD", "usdc.solana", "25.00"],
  ],
  [paymentsQueryKeys.counterpartyAccounts({ counterpartyId: "cpty_1" }), ["cpty_1"]],
  [paymentsQueryKeys.counterpartyRecentTransfers({ counterpartyId: "cpty_2" }), ["cpty_2"]],
  [paymentsQueryKeys.batchRecipients({ page: 3, search: "acme" }), [3, "acme"]],
  [paymentsQueryKeys.batchEstimate({ serializedRequest: '{"a":1}' }), ['{"a":1}']],
  [paymentsQueryKeys.paymentRequestCounterpartyAccounts({ counterpartyId: "cpty_3" }), ["cpty_3"]],
  [paymentsQueryKeys.transactionFilterOptions({ projectId: "prj_1" }), ["prj_1"]],
  [custodyQueryKeys.walletActivity({ walletId: "wal_1" }), ["wal_1"]],
  [custodyQueryKeys.walletPolicyRevisions({ walletId: "wal_2" }), ["wal_2"]],
  [issuanceQueryKeys.tokens({ query: DEFAULT_ISSUANCE_LIST_QUERY }), [DEFAULT_ISSUANCE_LIST_QUERY]],
  [earnQueryKeys.programDeposits({ programId: "prg_1" }), ["prg_1"]],
  [earnQueryKeys.strategies({ cluster: "devnet" }), ["devnet"]],
  [earnQueryKeys.vaultDeposit({ movementId: "mov_1" }), ["mov_1"]],
  [earnQueryKeys.vaultWithdrawal({ movementId: "mov_2" }), ["mov_2"]],
  [earnQueryKeys.programWithdrawals({ programId: "prg_2" }), ["prg_2"]],
  [earnQueryKeys.withdrawal({ programId: "prg_3", withdrawalRef: "wd_1" }), ["prg_3", "wd_1"]],
];

describe("dashboard query-key factories", () => {
  it("gives every key a unique cache prefix across all factories", () => {
    const prefixes = [...plainKeys, ...parameterizedKeys.map(([key]) => key[0])];
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("carries every param into the cache identity", () => {
    for (const [key, params] of parameterizedKeys) {
      for (const param of params) {
        expect(key).toContain(param);
      }
    }
  });
});
