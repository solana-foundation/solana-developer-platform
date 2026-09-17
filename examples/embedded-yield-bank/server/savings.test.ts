import { describe, expect, it } from "vitest";
import type { YieldMovement, YieldPosition, YieldStrategy } from "../src/types";
import {
  earnedFromLedger,
  pickSavingsStrategy,
  sharesForAmount,
  summarizeSavings,
  withdrawableAmount,
} from "./savings";
import { DEVNET_USDC_MINT } from "./solana";

describe("savings strategy", () => {
  it("picks the first instant-liquidity USDC strategy on devnet, in catalogue order", () => {
    const strategies = [
      strategy({ id: "veda-delayed", liquidityTerm: "delayed" }),
      strategy({ id: "eurc-instant", depositMints: ["eurc"] }),
      strategy({ id: "mainnet", hostCluster: "mainnet-beta" }),
      strategy({ id: "paused", status: "paused" }),
      strategy({ id: "kamino-usdc" }),
      strategy({ id: "steakhouse-usdc" }),
    ];

    expect(pickSavingsStrategy(strategies).id).toBe("kamino-usdc");
  });

  it("refuses to fall back to a delayed or non-USDC strategy", () => {
    const strategies = [
      strategy({ id: "veda-delayed", liquidityTerm: "delayed" }),
      strategy({ id: "eurc-instant", depositMints: ["eurc"] }),
    ];

    expect(() => pickSavingsStrategy(strategies)).toThrow(
      "instant liquidity and a USDC deposit mint"
    );
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
    expect(() => pickSavingsStrategy([])).toThrow("Set DEMO_STRATEGY_ID");
  });
});

describe("savings summary", () => {
  it("reports an empty savings account against checking", () => {
    expect(summarizeSavings({ amount: "20" }, null, [])).toEqual({
      balance: "0",
      withdrawable: "0",
      earned: "0",
      total: "20",
    });
  });

  it("adds the live position value to checking and earns from the ledger", () => {
    expect(
      summarizeSavings(
        { amount: "19.35" },
        position({
          shares: "0.65",
          withdrawableShares: "0.65",
          tokenValue: "0.66",
        }),
        [movement("deposit", "finalized", "0.65")]
      )
    ).toEqual({
      balance: "0.66",
      withdrawable: "0.66",
      earned: "0.01",
      total: "20.01",
    });
  });

  it("leaves totals undefined while the valuation is unavailable", () => {
    expect(summarizeSavings({ amount: "19.35" }, position({}), [])).toEqual({
      balance: undefined,
      withdrawable: undefined,
      earned: undefined,
      total: undefined,
    });
  });
});

describe("earnings from the strategy ledger", () => {
  it("counts payouts of finalized withdrawals and ignores failures", () => {
    expect(
      earnedFromLedger("1.5", [
        movement("withdrawal", "finalized", "1.5"),
        movement("deposit", "finalized", "2"),
        movement("deposit", "finalized", "1"),
        movement("deposit", "failed", "5"),
      ])
    ).toBe("0");
  });

  it("states realized earnings for a closed position", () => {
    expect(
      earnedFromLedger("0", [
        movement("withdrawal", "finalized", "10.4"),
        movement("deposit", "finalized", "10"),
      ])
    ).toBe("0.4");
  });

  it("is unstatable while a movement is pending or a payout is unvalued", () => {
    expect(
      earnedFromLedger("1", [movement("deposit", "submitted", "1")])
    ).toBeUndefined();
    expect(
      earnedFromLedger("1", [movement("withdrawal", "finalized", null)])
    ).toBeUndefined();
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

function movement(
  direction: YieldMovement["direction"],
  status: YieldMovement["status"],
  tokenAmount: string | null
): YieldMovement {
  return {
    movementId: `movement-${direction}-${status}-${tokenAmount}`,
    positionId: "position",
    provider: "provider",
    providerReference: "vault",
    direction,
    status,
    signature: "signature",
    amount: tokenAmount ?? "1",
    denomination: "mint",
    tokenMint: DEVNET_USDC_MINT,
    tokenAmount,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    settledAt: status === "finalized" ? "2026-01-01T00:00:01.000Z" : null,
  };
}
