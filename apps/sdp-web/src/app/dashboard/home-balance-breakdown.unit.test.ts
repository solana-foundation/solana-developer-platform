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
  it("keeps unpriced holdings out of the allocation entirely", () => {
    // The real case behind the redesign: one priced token, two org-issued ones with
    // no feed. Charting them together compares dollars against raw token counts.
    const result = buildHomeBalanceBreakdown([
      balance({ mint: "sol", token: "SOL", usdValue: 149.11 }),
      balance({ mint: "nwsol", token: "nwSOL", uiAmount: "132.5" }),
      balance({ mint: "atd", token: "ATD", uiAmount: "25000" }),
    ]);

    expect(result.priced.map((s) => s.token)).toEqual(["SOL"]);
    expect(result.unpriced.map((s) => s.token)).toEqual(["ATD", "nwSOL"]);
    expect(result.unpriced.every((s) => s.sharePercent === 0)).toBe(true);
    expect(result.totalUsd).toBeCloseTo(149.11);
  });

  it("makes priced shares sum to 100 so a stacked bar is whole", () => {
    const result = buildHomeBalanceBreakdown([
      balance({ mint: "a", usdValue: 75 }),
      balance({ mint: "b", usdValue: 25 }),
    ]);

    expect(result.priced.map((s) => s.sharePercent)).toEqual([75, 25]);
    expect(result.priced.reduce((sum, s) => sum + s.sharePercent, 0)).toBeCloseTo(100);
  });

  it("orders priced holdings largest first", () => {
    const result = buildHomeBalanceBreakdown([
      balance({ mint: "small", usdValue: 5 }),
      balance({ mint: "big", usdValue: 50 }),
      balance({ mint: "mid", usdValue: 20 }),
    ]);

    expect(result.priced.map((s) => s.mint)).toEqual(["big", "mid", "small"]);
  });

  it("orders unpriced holdings by amount, largest first", () => {
    const result = buildHomeBalanceBreakdown([
      balance({ mint: "few", uiAmount: "10" }),
      balance({ mint: "many", uiAmount: "9000" }),
    ]);

    expect(result.unpriced.map((s) => s.mint)).toEqual(["many", "few"]);
  });

  it("folds priced holdings past the cap into one Other bucket", () => {
    const many = Array.from({ length: 7 }, (_, i) => balance({ mint: `m${i}`, usdValue: 10 }));
    const result = buildHomeBalanceBreakdown(many, 4);

    expect(result.priced).toHaveLength(4);
    expect(result.otherPricedCount).toBe(3);
    expect(result.otherPricedUsd).toBe(30);
    // Named shares plus Other still account for the whole bar.
    const total =
      result.priced.reduce((sum, s) => sum + s.sharePercent, 0) + result.otherPricedSharePercent;
    expect(total).toBeCloseTo(100);
  });

  it("derives value from price when usdValue is absent", () => {
    const result = buildHomeBalanceBreakdown([
      balance({ mint: "priced", uiAmount: "3", usdPrice: 7 }),
    ]);

    expect(result.priced[0].usdValue).toBe(21);
  });

  it("treats a non-finite amount as unpriced rather than producing NaN", () => {
    const result = buildHomeBalanceBreakdown([
      balance({ mint: "bad", uiAmount: "not-a-number", usdPrice: 2 }),
    ]);

    expect(result.priced).toHaveLength(0);
    expect(result.unpriced.map((s) => s.mint)).toEqual(["bad"]);
    expect(result.totalUsd).toBeNull();
  });

  it("reports no total when nothing is priced", () => {
    const result = buildHomeBalanceBreakdown([balance({ mint: "a" }), balance({ mint: "b" })]);

    expect(result.totalUsd).toBeNull();
    expect(result.priced).toHaveLength(0);
    expect(result.unpriced).toHaveLength(2);
  });

  it("returns empty for no balances", () => {
    const result = buildHomeBalanceBreakdown([]);
    expect(result.priced).toEqual([]);
    expect(result.unpriced).toEqual([]);
    expect(result.totalUsd).toBeNull();
  });
});

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
    // Matches the rule wallet-asset-breakdown.tsx already applies to this data. The
    // list still shows the row (as unpriced) — showing something unexplained beats
    // hiding it — but nothing that cannot be ranked or summed is claimed as a holding.
    const balances = [
      balance({ mint: "ok", uiAmount: "3" }),
      balance({ mint: "bad", uiAmount: "not-a-number" }),
    ];

    expect(countHeldTokens(balances)).toBe(1);
    expect(buildHomeBalanceBreakdown(balances).unpriced.map((s) => s.mint)).toContain("bad");
  });

  it("agrees with what the breakdown lists", () => {
    const balances = [
      balance({ mint: "sol", token: "SOL", uiAmount: "2", usdValue: 149.11 }),
      balance({ mint: "spent", token: "SPENT", uiAmount: "0", usdValue: 0 }),
      balance({ mint: "nwsol", token: "nwSOL", uiAmount: "132.5" }),
    ];
    const breakdown = buildHomeBalanceBreakdown(balances);
    const listed = [...breakdown.priced, ...breakdown.unpriced].length;

    expect(countHeldTokens(balances)).toBe(2);
    expect(listed).toBe(2);
    expect([...breakdown.priced, ...breakdown.unpriced].map((s) => s.token)).not.toContain("SPENT");
  });

  it("is zero for no balances", () => {
    expect(countHeldTokens([])).toBe(0);
  });
});

describe("unpriced cap", () => {
  it("lists only the first few unpriced holdings and counts the rest", () => {
    // An organization issuing a dozen of its own tokens turned the card into a
    // ledger; only the largest few are listed and the remainder is a count.
    const many = Array.from({ length: 11 }, (_, i) =>
      balance({ mint: `u${i}`, token: `TKN${i}`, uiAmount: String(100 - i) })
    );
    const result = buildHomeBalanceBreakdown(many);

    expect(result.unpriced).toHaveLength(4);
    expect(result.otherUnpricedCount).toBe(7);
    expect(result.unpriced[0].mint).toBe("u0");
  });

  it("counts nothing extra when the unpriced list fits", () => {
    const result = buildHomeBalanceBreakdown([balance({ mint: "a" }), balance({ mint: "b" })]);
    expect(result.unpriced).toHaveLength(2);
    expect(result.otherUnpricedCount).toBe(0);
  });
});
