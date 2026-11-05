import { describe, expect, it } from "vitest";
import { earnQueryKeys } from "@/app/(session)/dashboard/[projectId]/markets/earn/earn-query-key";
import { paymentsQueryKeys } from "@/app/(session)/dashboard/[projectId]/payments/payments-query-key";
import { custodyQueryKeys } from "./custody-query-key";

const parameterizedKeys: [key: readonly unknown[], params: unknown[]][] = [
  [custodyQueryKeys.walletActivity({ walletId: "wal_1" }), ["wal_1"]],
  [custodyQueryKeys.walletBalances({ walletId: "wal_3", readAt: 1 }), ["wal_3", 1]],
];

describe("custody query keys", () => {
  it("gives every key a unique cache prefix", () => {
    const prefixes = [
      custodyQueryKeys.walletCardBalances(),
      ...parameterizedKeys.map(([key]) => key[0]),
    ];
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("matches every wallet live-data key and nothing else", () => {
    const matches = [
      custodyQueryKeys.walletBalances({ walletId: "wal_1", readAt: 1 }),
      custodyQueryKeys.walletActivity({ walletId: "wal_1" }),
      custodyQueryKeys.walletCardBalances(),
      custodyQueryKeys.walletCardBalanceFallback({ walletId: "wal_1" }),
    ];
    for (const key of matches) {
      expect(custodyQueryKeys.isWalletLiveDataKey(key)).toBe(true);
    }
    const nonMatches = [paymentsQueryKeys.actionWallets(), earnQueryKeys.fundingWallets()];
    for (const key of nonMatches) {
      expect(custodyQueryKeys.isWalletLiveDataKey(key)).toBe(false);
    }
  });

  it("carries every param into the cache identity", () => {
    for (const [key, params] of parameterizedKeys) {
      for (const param of params) {
        expect(key).toContain(param);
      }
    }
  });
});
