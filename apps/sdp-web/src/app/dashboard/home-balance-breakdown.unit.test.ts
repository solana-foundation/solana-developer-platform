import type { CustodyWalletTokenBalance } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { countHeldTokens } from "./home-balance-breakdown";

function balance(overrides: Partial<CustodyWalletTokenBalance>): CustodyWalletTokenBalance {
  return {
    token: "USDC",
    mint: "mint-usdc",
    amount: "1000000",
    uiAmount: "1",
    decimals: 6,
    ...overrides,
  };
}

describe("countHeldTokens", () => {
  it("counts distinct mints, not rows", () => {
    expect(
      countHeldTokens([balance({ mint: "a" }), balance({ mint: "a" }), balance({ mint: "b" })])
    ).toBe(2);
  });

  it("does not count a mint whose balance is spent", () => {
    // A spent token account keeps its aggregate row, so counting rows claimed
    // holdings the organization no longer has.
    expect(
      countHeldTokens([
        balance({ mint: "a", uiAmount: "1" }),
        balance({ mint: "b", uiAmount: "0" }),
        balance({ mint: "c", uiAmount: "0.0" }),
      ])
    ).toBe(1);
  });

  it("does not count an amount it cannot parse", () => {
    // Matches the rule wallet-asset-breakdown.tsx already applies to this data: nothing
    // that cannot be ranked or summed is claimed as a holding.
    expect(
      countHeldTokens([
        balance({ mint: "ok", uiAmount: "3" }),
        balance({ mint: "bad", uiAmount: "not-a-number" }),
      ])
    ).toBe(1);
  });

  it("is zero for no balances", () => {
    expect(countHeldTokens([])).toBe(0);
  });
});
