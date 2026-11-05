import { describe, expect, it } from "vitest";
import { paymentsQueryKeys } from "./payments-query-key";

const plainKeys = [
  paymentsQueryKeys.actionCounterparties(),
  paymentsQueryKeys.actionWallets(),
  paymentsQueryKeys.counterpartyFieldOptions(),
];

const parameterizedKeys: [key: readonly unknown[], params: unknown[]][] = [
  [paymentsQueryKeys.walletAddressQr("wallet-address"), ["wallet-address"]],
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
  [paymentsQueryKeys.batchRecipients({ page: 3, search: "acme" }), [3, "acme"]],
  [paymentsQueryKeys.batchEstimate({ serializedRequest: '{"a":1}' }), ['{"a":1}']],
  [paymentsQueryKeys.transactionFilterOptions({ projectId: "prj_1" }), ["prj_1"]],
];

describe("payments query keys", () => {
  it("gives every key a unique cache prefix", () => {
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
