import { describe, expect, it } from "vitest";
import type { TokenEarnings, YieldPosition, YieldStrategy } from "../src/types";
import {
  pickSavingsStrategy,
  sharesForAmount,
  summarizeSavings,
  withdrawableAmount,
} from "./savings";
import { DEVNET_USDC_MINT } from "./solana";

describe("savings strategy", () => {
  it("prefers an instant-liquidity USDC strategy on devnet", () => {
    const strategies = [
      strategy({ id: "veda-delayed", liquidityTerm: "delayed" }),
      strategy({ id: "eurc-instant", depositMints: ["eurc"] }),
      strategy({ id: "kamino-usdc" }),
      strategy({ id: "mainnet", hostCluster: "mainnet-beta" }),
      strategy({ id: "paused", status: "paused" }),
    ];

    expect(pickSavingsStrategy(strategies).id).toBe("kamino-usdc");
  });

  it("honours DEMO_STRATEGY_ID even when it is paused for deposits", () => {
    const strategies = [
      strategy({ id: "kamino-usdc" }),
      strategy({ id: "veda-usdc", status: "paused" }),
    ];

    expect(pickSavingsStrategy(strategies, "veda-usdc").id).toBe("veda-usdc");
    expect(() => pickSavingsStrategy(strategies, "missing")).toThrow(
      "not in the SDP strategy catalogue"
    );
  });

  it("explains an empty catalogue", () => {
    expect(() => pickSavingsStrategy([])).toThrow(
      "no fundable devnet strategy"
    );
  });
});

describe("savings summary", () => {
  it("reports an empty savings account against checking", () => {
    expect(summarizeSavings({ amount: "20" }, null, undefined)).toEqual({
      balance: "0",
      withdrawable: "0",
      earned: "0",
      total: "20",
    });
  });

  it("adds the live position value to checking", () => {
    expect(
      summarizeSavings(
        { amount: "19.35" },
        position({
          shares: "0.65",
          withdrawableShares: "0.65",
          tokenValue: "0.66",
        }),
        earnings("0.01")
      )
    ).toEqual({
      balance: "0.66",
      withdrawable: "0.66",
      earned: "0.01",
      total: "20.01",
    });
  });

  it("leaves totals undefined while the valuation is unavailable", () => {
    expect(
      summarizeSavings({ amount: "19.35" }, position({}), undefined)
    ).toEqual({
      balance: undefined,
      withdrawable: undefined,
      earned: undefined,
      total: undefined,
    });
  });
});

describe("amount to shares", () => {
  const live = position({
    shares: "100",
    withdrawableShares: "80",
    tokenValue: "110",
  });

  it("values withdrawable shares at the live share price", () => {
    expect(withdrawableAmount(live)).toBe("88");
  });

  it("sends the exact withdrawable shares for a full withdrawal", () => {
    expect(sharesForAmount("88", live)).toBe("80");
  });

  it("scales a partial withdrawal by the share price", () => {
    expect(sharesForAmount("11", live)).toBe("10");
    expect(sharesForAmount("0.000011", live)).toBe("0.00001");
  });

  it("rejects amounts the account cannot cover or express", () => {
    expect(() => sharesForAmount("88.01", live)).toThrow(
      "Only 88 is available"
    );
    expect(() => sharesForAmount("0.0000001", live)).toThrow(
      "up to 6 decimal places"
    );
    expect(() => sharesForAmount("1", position({}))).toThrow("still updating");
  });
});

function strategy(overrides: Partial<YieldStrategy>): YieldStrategy {
  return {
    id: "strategy",
    provider: "provider",
    providerReference: "vault",
    name: "Strategy",
    sourceKind: "defi",
    depositMints: [DEVNET_USDC_MINT],
    liquidityTerm: "instant",
    status: "active",
    hostCluster: "devnet",
    fundable: true,
    depositSlippage: null,
    withdrawalSlippage: null,
    ...overrides,
  };
}

function position(
  overrides: Pick<YieldPosition, "shares" | "withdrawableShares" | "tokenValue">
): YieldPosition {
  return {
    id: "position",
    ownerAddress: "owner",
    provider: "provider",
    providerReference: "vault",
    label: "Savings",
    tokenMint: DEVNET_USDC_MINT,
    shareMint: "shares",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function earnings(earned: string): TokenEarnings {
  return {
    tokenMint: DEVNET_USDC_MINT,
    positionCount: 1,
    unavailablePositionCount: 0,
    currentValue: "0.66",
    totalDeposited: "0.65",
    earned,
  };
}
