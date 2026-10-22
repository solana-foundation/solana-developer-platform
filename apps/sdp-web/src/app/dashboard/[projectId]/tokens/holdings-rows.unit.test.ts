import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { describe, expect, it } from "vitest";
import { buildHoldingsRows } from "./holdings-rows";

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

describe("buildHoldingsRows", () => {
  it("lists every holding, unlike the home card which caps at four", () => {
    const balances = Array.from({ length: 12 }, (_, index) =>
      balance({ mint: `mint-${index}`, token: `TK${index}`, usdValue: index + 1 })
    );

    expect(buildHoldingsRows(balances)).toHaveLength(12);
  });

  it("ranks priced holdings above unpriced ones", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "atd", token: "ATD", tokenAmount: "25000", displayAmount: "25000" }),
      balance({ mint: "sol", token: "SOL", usdValue: 149.11 }),
    ]);

    expect(rows.map((row) => row.token)).toEqual(["SOL", "ATD"]);
  });

  it("orders priced holdings by value, largest first", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "a", token: "A", usdValue: 5 }),
      balance({ mint: "b", token: "B", usdValue: 50 }),
      balance({ mint: "c", token: "C", usdValue: 20 }),
    ]);

    expect(rows.map((row) => row.token)).toEqual(["B", "C", "A"]);
  });

  it("orders unpriced holdings by amount, largest first", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "a", token: "A", tokenAmount: "5", displayAmount: "5" }),
      balance({ mint: "b", token: "B", tokenAmount: "500", displayAmount: "500" }),
    ]);

    expect(rows.map((row) => row.token)).toEqual(["B", "A"]);
  });

  it("ranks an interest-bearing holding by the display amount it shows", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "a", token: "A", tokenAmount: "100", displayAmount: "100" }),
      balance({
        mint: "b",
        token: "B",
        tokenAmount: "99",
        displayAmount: "101.5",
        displayRule: "interest",
        displayAsOf: "2026-10-22T12:00:00.000Z",
      }),
    ]);

    expect(rows.map((row) => [row.token, row.displayAmount, row.displayRule])).toEqual([
      ["B", "101.5", "interest"],
      ["A", "100", "plain"],
    ]);
  });

  it("drops spent token accounts that report a zero amount", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "spent", token: "SPENT", tokenAmount: "0", displayAmount: "0" }),
      balance({ mint: "held", token: "HELD", tokenAmount: "3", displayAmount: "3" }),
    ]);

    expect(rows.map((row) => row.token)).toEqual(["HELD"]);
  });

  it("computes each priced holding's share of the priced total", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "a", token: "A", usdValue: 75 }),
      balance({ mint: "b", token: "B", usdValue: 25 }),
    ]);

    expect(rows.map((row) => row.sharePercent)).toEqual([75, 25]);
  });

  it("gives unpriced holdings no share rather than a misleading zero-width one", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "a", token: "A", usdValue: 100 }),
      balance({ mint: "atd", token: "ATD", tokenAmount: "25000", displayAmount: "25000" }),
    ]);

    expect(rows[1]).toMatchObject({ token: "ATD", sharePercent: null, usdValue: null });
  });

  it("returns nothing for an organization holding nothing", () => {
    expect(buildHoldingsRows([])).toEqual([]);
  });
});
