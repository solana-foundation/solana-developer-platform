import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { describe, expect, it } from "vitest";
import { buildHomeBalanceBreakdown, countHeldTokens } from "./home-balance-breakdown";

function balance(overrides: Partial<CustodyWalletTokenBalance>): CustodyWalletTokenBalance {
  return {
    token: "USDC",
    mint: "mint-usdc",
    amount: "1000000",
    tokenAmount: "1",
    displayAmount: "1",
    displayAsOf: null,
    displayRule: "plain",
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
      balance({ mint: "nwsol", token: "nwSOL", tokenAmount: "132.5", displayAmount: "132.5" }),
      balance({ mint: "atd", token: "ATD", tokenAmount: "25000", displayAmount: "25000" }),
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
      balance({ mint: "few", tokenAmount: "10", displayAmount: "10" }),
      balance({ mint: "many", tokenAmount: "9000", displayAmount: "9000" }),
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
      balance({ mint: "priced", tokenAmount: "3", displayAmount: "3", usdPrice: 7 }),
    ]);

    expect(result.priced[0].usdValue).toBe(21);
  });

  it("ranks and prices a scaled holding by the display amount a wallet shows", () => {
    const scaled = { displayRule: "scaled", displayAsOf: "2026-10-22T12:00:00.000Z" } as const;
    const result = buildHomeBalanceBreakdown([
      balance({ mint: "plain", tokenAmount: "100", displayAmount: "100" }),
      balance({ mint: "scaled", tokenAmount: "10", displayAmount: "500", ...scaled }),
      balance({ mint: "priced", tokenAmount: "2", displayAmount: "4", usdPrice: 3, ...scaled }),
    ]);

    expect(result.unpriced.map((s) => s.mint)).toEqual(["scaled", "plain"]);
    expect(result.unpriced[0]?.displayAmount).toBe("500");
    expect(result.priced[0]?.usdValue).toBe(12);
  });

  it("treats a non-finite amount as unpriced rather than producing NaN", () => {
    const result = buildHomeBalanceBreakdown([
      balance({
        mint: "bad",
        tokenAmount: "not-a-number",
        displayAmount: "not-a-number",
        usdPrice: 2,
      }),
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
        balance({ mint: "a", tokenAmount: "1", displayAmount: "1" }),
        balance({ mint: "b", tokenAmount: "0", displayAmount: "0" }),
        balance({ mint: "c", tokenAmount: "0.0", displayAmount: "0.0" }),
      ])
    ).toBe(1);
  });

  it("does not count an amount it cannot parse", () => {
    // Matches the rule wallet-asset-breakdown.tsx already applies to this data. The
    // list still shows the row (as unpriced) — showing something unexplained beats
    // hiding it — but nothing that cannot be ranked or summed is claimed as a holding.
    const balances = [
      balance({ mint: "ok", tokenAmount: "3", displayAmount: "3" }),
      balance({ mint: "bad", tokenAmount: "not-a-number", displayAmount: "not-a-number" }),
    ];

    expect(countHeldTokens(balances)).toBe(1);
    expect(buildHomeBalanceBreakdown(balances).unpriced.map((s) => s.mint)).toContain("bad");
  });

  it("agrees with what the breakdown lists", () => {
    const balances = [
      balance({
        mint: "sol",
        token: "SOL",
        tokenAmount: "2",
        displayAmount: "2",
        usdValue: 149.11,
      }),
      balance({ mint: "spent", token: "SPENT", tokenAmount: "0", displayAmount: "0", usdValue: 0 }),
      balance({ mint: "nwsol", token: "nwSOL", tokenAmount: "132.5", displayAmount: "132.5" }),
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
      balance({
        mint: `u${i}`,
        token: `TKN${i}`,
        tokenAmount: String(100 - i),
        displayAmount: String(100 - i),
      })
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
