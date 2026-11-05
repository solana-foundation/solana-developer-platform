import { describe, expect, it } from "vitest";
import { earnQueryKeys } from "./earn-query-key";

const plainKeys = [
  earnQueryKeys.programs(),
  earnQueryKeys.vaultPositions(),
  earnQueryKeys.vaultDepositsInFlight(),
  earnQueryKeys.vaultWithdrawalsInFlight(),
  earnQueryKeys.fundingWallets(),
];

const parameterizedKeys: [key: readonly unknown[], params: unknown[]][] = [
  [earnQueryKeys.strategies({ cluster: "devnet" }), ["devnet"]],
  [earnQueryKeys.vaultDeposit({ movementId: "mov_1" }), ["mov_1"]],
  [earnQueryKeys.vaultWithdrawal({ movementId: "mov_2" }), ["mov_2"]],
  [earnQueryKeys.programWithdrawals({ programId: "prg_2" }), ["prg_2"]],
  [earnQueryKeys.withdrawal({ programId: "prg_3", withdrawalRef: "wd_1" }), ["prg_3", "wd_1"]],
];

describe("earn query keys", () => {
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
