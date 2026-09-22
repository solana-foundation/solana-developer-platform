import { describe, expect, it } from "vitest";
import type {
  YieldMovement,
  YieldPosition,
  YieldStrategy,
  YieldWithdrawalOptions,
  YieldWithdrawalRequest,
} from "../src/types";
import { ApiRequestError } from "./http";
import {
  assertQueuedWithdrawalTerms,
  earnedFromLedger,
  pickSavingsStrategy,
  sharesForAmount,
  summarizeSavings,
  withdrawableAmount,
} from "./savings";
import { USDC_MINTS } from "./solana";

describe("savings strategy", () => {
  it("picks the first fundable DeFi USDC strategy without inferring its exit route", () => {
    const strategies = [
      strategy({ id: "rwa-usdc", sourceKind: "rwa" }),
      strategy({ id: "veda-delayed", liquidityTerm: "delayed" }),
      strategy({ id: "eurc-instant", depositMints: ["eurc"] }),
      strategy({ id: "mainnet", hostCluster: "mainnet-beta" }),
      strategy({ id: "paused", status: "paused" }),
      strategy({ id: "kamino-usdc" }),
      strategy({ id: "steakhouse-usdc" }),
    ];

    expect(pickSavingsStrategy(strategies, "devnet").id).toBe("veda-delayed");
  });

  it("picks a mainnet USDC strategy when mainnet is configured", () => {
    const strategies = [
      strategy({ id: "devnet", hostCluster: "devnet" }),
      strategy({
        id: "mainnet-rwa",
        sourceKind: "rwa",
        hostCluster: "mainnet-beta",
        depositMints: [USDC_MINTS["mainnet-beta"]],
      }),
      strategy({
        id: "mainnet",
        hostCluster: "mainnet-beta",
        depositMints: [USDC_MINTS["mainnet-beta"]],
      }),
    ];

    expect(pickSavingsStrategy(strategies, "mainnet-beta").id).toBe("mainnet");
  });

  it("refuses to fall back to an RWA or non-USDC strategy", () => {
    const strategies = [
      strategy({ id: "rwa-usdc", sourceKind: "rwa" }),
      strategy({ id: "eurc-instant", depositMints: ["eurc"] }),
    ];

    expect(() => pickSavingsStrategy(strategies, "devnet")).toThrow(
      "with a USDC deposit mint"
    );
  });

  it("honours DEMO_STRATEGY_ID even when it is paused for deposits", () => {
    const strategies = [
      strategy({ id: "kamino-usdc" }),
      strategy({ id: "veda-usdc", status: "paused" }),
    ];

    expect(pickSavingsStrategy(strategies, "devnet", "veda-usdc").id).toBe(
      "veda-usdc"
    );
    expect(() => pickSavingsStrategy(strategies, "devnet", "missing")).toThrow(
      "not in the SDP strategy catalogue"
    );
  });

  it("rejects an explicitly pinned strategy from another cluster", () => {
    expect(() =>
      pickSavingsStrategy(
        [strategy({ id: "mainnet", hostCluster: "mainnet-beta" })],
        "devnet",
        "mainnet"
      )
    ).toThrow("is not a devnet strategy");
  });

  it("explains an empty catalogue", () => {
    expect(() => pickSavingsStrategy([], "devnet")).toThrow(
      "Set DEMO_STRATEGY_ID"
    );
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

  it("keeps queued escrow in savings value without calling it withdrawable", () => {
    expect(
      summarizeSavings(
        { amount: "10" },
        position({ shares: "5", withdrawableShares: "5", tokenValue: "5" }),
        [movement("deposit", "finalized", "9.95")],
        [withdrawalRequest("pending", "4.95")]
      )
    ).toEqual({
      balance: "9.95",
      withdrawable: "5",
      earned: "0",
      total: "19.95",
    });
  });

  it("does not guess a balance while a queue close is unclassified", () => {
    expect(
      summarizeSavings(
        { amount: "10" },
        position({ shares: "5", withdrawableShares: "5", tokenValue: "5" }),
        [],
        [withdrawalRequest("closedOrUnknown", "4.95")]
      )
    ).toEqual({
      balance: undefined,
      withdrawable: "5",
      earned: undefined,
      total: undefined,
    });
  });
});

describe("queued withdrawal terms", () => {
  const options: YieldWithdrawalOptions = {
    positionId: "position",
    instant: true,
    providerOrder: false,
    queued: true,
    withdrawAuthority: "authority",
    queueState: "queue",
    queueAsset: {
      assetMint: USDC_MINTS.devnet,
      allowWithdrawals: true,
      secondsToMaturity: 60,
      minimumSecondsToDeadline: 300,
      maximumSecondsToDeadline: 7_776_000,
      minimumDiscountBps: 25,
      maximumDiscountBps: 75,
      minimumShares: "1.5",
      shareDecimals: 6,
    },
  };

  it("accepts exact live boundaries", () => {
    expect(() =>
      assertQueuedWithdrawalTerms(options, "1.5", 25, 300)
    ).not.toThrow();
    expect(() =>
      assertQueuedWithdrawalTerms(options, "1.500000", 75, 7_776_000)
    ).not.toThrow();
  });

  it("rejects below-minimum shares and above-maximum deadlines", () => {
    expect(() =>
      assertQueuedWithdrawalTerms(options, "1.499999", 25, 300)
    ).toThrow("at least 1.5 shares");
    expect(() =>
      assertQueuedWithdrawalTerms(options, "1.5", 25, 7_776_001)
    ).toThrow("from 300 to 7776000 seconds");
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
  });

  it("reports an unavailable valuation as a retryable server fault", () => {
    expect(() => sharesForAmount("1", position({}))).toThrow("still updating");
    try {
      sharesForAmount("1", position({}));
    } catch (caught) {
      expect(caught).toMatchObject({
        status: 503,
        code: "VALUATION_UNAVAILABLE",
      });
    }
  });

  it("rejects client-input amounts as 400s, not server faults", () => {
    expect(() => sharesForAmount("88.01", live)).toThrow(ApiRequestError);
    expect(() => sharesForAmount("0.0000001", live)).toThrow(ApiRequestError);
    expect(() => sharesForAmount("0.000001", live)).toThrow(ApiRequestError);
    try {
      sharesForAmount("88.01", live);
    } catch (caught) {
      expect(caught).toMatchObject({ status: 400, code: "INVALID_REQUEST" });
    }
  });
});

function strategy(overrides: Partial<YieldStrategy>): YieldStrategy {
  return {
    id: "strategy",
    provider: "provider",
    providerReference: "vault",
    name: "Strategy",
    sourceKind: "defi",
    depositMints: [USDC_MINTS.devnet],
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
    tokenMint: USDC_MINTS.devnet,
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
    tokenMint: USDC_MINTS.devnet,
    tokenAmount,
    failureReason: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    settledAt: status === "finalized" ? "2026-01-01T00:00:01.000Z" : null,
  };
}

function withdrawalRequest(
  status: YieldWithdrawalRequest["status"],
  quotedAssets: string
): YieldWithdrawalRequest {
  return {
    withdrawalRequestId: `request-${status}`,
    positionId: "position",
    provider: "provider",
    providerReference: "vault",
    ownerAddress: "owner",
    requestAddress: "request-address",
    status,
    assetMint: USDC_MINTS.devnet,
    shareMint: "shares",
    shares: "5",
    quotedAssets,
    shareDecimals: 6,
    assetDecimals: 6,
    discountBps: 50,
    nonce: "1",
    creationTimestamp: "1",
    maturityTimestamp: "2",
    deadlineTimestamp: "3",
    creationSignature: "signature",
    cancelSignature: null,
    closingSignature: null,
    assetsPaid: null,
    failureReason: null,
    fulfilledAt: null,
    cancelledAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}
