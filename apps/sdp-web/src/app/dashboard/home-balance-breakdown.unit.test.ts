import type { CustodyWalletTokenBalance } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { buildHomeBalanceBreakdown, countHeldTokens } from "./home-balance-breakdown";

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

describe("buildHomeBalanceBreakdown", () => {
  it("orders holdings by value, largest first", () => {
    const slices = buildHomeBalanceBreakdown([
      balance({ mint: "a", token: "A", usdValue: 5 }),
      balance({ mint: "b", token: "B", usdValue: 50 }),
      balance({ mint: "c", token: "C", usdValue: 20 }),
    ]);

    expect(slices.map((s) => s.mint)).toEqual(["b", "c", "a"]);
  });

  it("scales bars against the largest holding, not the total", () => {
    const slices = buildHomeBalanceBreakdown([
      balance({ mint: "big", usdValue: 100 }),
      balance({ mint: "small", usdValue: 25 }),
    ]);

    expect(slices[0].sharePercent).toBe(100);
    // 25/100 of the largest, not 25/125 of the total.
    expect(slices[1].sharePercent).toBe(25);
  });

  it("keeps a small holding visible instead of rounding it away", () => {
    const slices = buildHomeBalanceBreakdown([
      balance({ mint: "whale", usdValue: 1_000_000 }),
      balance({ mint: "dust", usdValue: 1 }),
    ]);

    expect(slices[1].sharePercent).toBeGreaterThanOrEqual(2);
  });

  it("derives value from price when usdValue is absent", () => {
    const slices = buildHomeBalanceBreakdown([
      balance({ mint: "priced", uiAmount: "3", usdPrice: 7 }),
    ]);

    expect(slices[0].usdValue).toBe(21);
  });

  it("sorts unpriced holdings last and gives them no bar", () => {
    const slices = buildHomeBalanceBreakdown([
      balance({ mint: "unpriced" }),
      balance({ mint: "priced", usdValue: 10 }),
    ]);

    expect(slices.map((s) => s.mint)).toEqual(["priced", "unpriced"]);
    expect(slices[1].usdValue).toBeNull();
    expect(slices[1].sharePercent).toBe(0);
  });

  it("ignores a non-finite price rather than producing NaN", () => {
    const slices = buildHomeBalanceBreakdown([
      balance({ mint: "bad", uiAmount: "not-a-number", usdPrice: 2 }),
    ]);

    expect(slices[0].usdValue).toBeNull();
    expect(slices[0].sharePercent).toBe(0);
  });

  it("caps the row count", () => {
    const many = Array.from({ length: 9 }, (_, i) => balance({ mint: `m${i}`, usdValue: 9 - i }));

    expect(buildHomeBalanceBreakdown(many)).toHaveLength(5);
    expect(buildHomeBalanceBreakdown(many, 3)).toHaveLength(3);
  });

  it("returns nothing for no balances", () => {
    expect(buildHomeBalanceBreakdown([])).toEqual([]);
  });
});

describe("countHeldTokens", () => {
  it("counts distinct mints, not rows", () => {
    expect(
      countHeldTokens([balance({ mint: "a" }), balance({ mint: "a" }), balance({ mint: "b" })])
    ).toBe(2);
  });

  it("is zero for no balances", () => {
    expect(countHeldTokens([])).toBe(0);
  });
});
