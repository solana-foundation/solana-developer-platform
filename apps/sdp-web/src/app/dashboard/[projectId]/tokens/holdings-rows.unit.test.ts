import type { CustodyWalletTokenBalance } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { buildHoldingsRows } from "./holdings-rows";

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

describe("buildHoldingsRows", () => {
  it("lists every holding, unlike the home card which caps at four", () => {
    const balances = Array.from({ length: 12 }, (_, index) =>
      balance({ mint: `mint-${index}`, token: `TK${index}`, usdValue: index + 1 })
    );

    expect(buildHoldingsRows(balances)).toHaveLength(12);
  });

  it("ranks priced holdings above unpriced ones", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "atd", token: "ATD", uiAmount: "25000" }),
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
      balance({ mint: "a", token: "A", uiAmount: "5" }),
      balance({ mint: "b", token: "B", uiAmount: "500" }),
    ]);

    expect(rows.map((row) => row.token)).toEqual(["B", "A"]);
  });

  it("drops spent token accounts that report a zero amount", () => {
    const rows = buildHoldingsRows([
      balance({ mint: "spent", token: "SPENT", uiAmount: "0" }),
      balance({ mint: "held", token: "HELD", uiAmount: "3" }),
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
      balance({ mint: "atd", token: "ATD", uiAmount: "25000" }),
    ]);

    expect(rows[1]).toMatchObject({ token: "ATD", sharePercent: null, usdValue: null });
  });

  it("returns nothing for an organization holding nothing", () => {
    expect(buildHoldingsRows([])).toEqual([]);
  });
});
