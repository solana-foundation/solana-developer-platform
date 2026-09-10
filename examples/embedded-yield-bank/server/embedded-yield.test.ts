import { describe, expect, it, vi } from "vitest";
import type {
  TokenBalance,
  TokenEarnings,
  YieldPosition,
  YieldStrategy,
} from "../src/types.ts";
import {
  assertBuiltFeePayer,
  deriveWithdrawalFloor,
  summarizeAccountToken,
} from "./embedded-yield.ts";
import { SdpApiError } from "./sdp-client.ts";

describe("Embedded Yield orchestration", () => {
  it("keeps account totals in one token denomination", () => {
    const balances: TokenBalance[] = [
      { mint: "eurc", symbol: "EURC", amount: "100", decimals: 6 },
      { mint: "usdc", symbol: "USDC", amount: "20", decimals: 6 },
    ];
    const positions = [
      position("usdc-position", "usdc", "1.25"),
      position("eurc-position", "eurc", "50"),
    ];
    const earnings: TokenEarnings[] = [
      earningsFor("usdc", "0.25"),
      earningsFor("eurc", "10"),
    ];

    expect(summarizeAccountToken(balances, positions, earnings)).toEqual({
      tokenMint: "usdc",
      tokenSymbol: "USDC",
      available: "20",
      inYield: "1.25",
      portfolio: "21.25",
      earned: "0.25",
      unavailableYieldPositions: 0,
    });
  });

  it("quotes a withdrawal when its strategy is absent from the catalogue", async () => {
    const previewWithdrawal = vi.fn().mockResolvedValue({
      assetsOut: "10",
      assetDecimals: 6,
      blockingIssues: [],
    });

    await expect(
      deriveWithdrawalFloor(
        { previewWithdrawal },
        { id: "position" },
        "10",
        undefined
      )
    ).resolves.toBe("9.99");
    expect(previewWithdrawal).toHaveBeenCalledWith("position", "10");
  });

  it("continues without a floor when a hidden provider cannot quote exits", async () => {
    const previewWithdrawal = vi
      .fn()
      .mockRejectedValue(
        new SdpApiError(501, "NOT_IMPLEMENTED", "Quote unavailable")
      );

    await expect(
      deriveWithdrawalFloor(
        { previewWithdrawal },
        { id: "position" },
        "10",
        undefined
      )
    ).resolves.toBeUndefined();
  });

  it("uses the catalogue policy when the strategy is present", async () => {
    const previewWithdrawal = vi.fn().mockResolvedValue({
      assetsOut: "10",
      assetDecimals: 6,
      blockingIssues: [],
    });

    await expect(
      deriveWithdrawalFloor(
        { previewWithdrawal },
        { id: "position" },
        "10",
        strategy({ quoteRequired: true, defaultToleranceBps: 50 })
      )
    ).resolves.toBe("9.95");
  });

  it("rejects a transaction whose fee payer differs from the request", () => {
    expect(() => assertBuiltFeePayer("northstar", "northstar")).not.toThrow();
    expect(() => assertBuiltFeePayer(undefined, undefined)).not.toThrow();
    expect(() => assertBuiltFeePayer("unexpected", "northstar")).toThrow(
      "unexpected fee payer"
    );
  });
});

function position(
  id: string,
  tokenMint: string,
  tokenValue: string
): YieldPosition {
  return {
    id,
    ownerAddress: "owner",
    provider: "provider",
    providerReference: "vault",
    label: id,
    tokenMint,
    shareMint: "shares",
    createdAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
    shares: "1",
    withdrawableShares: "1",
    tokenValue,
  };
}

function earningsFor(tokenMint: string, earned: string): TokenEarnings {
  return {
    tokenMint,
    positionCount: 1,
    unavailablePositionCount: 0,
    currentValue: "1",
    totalDeposited: "0.75",
    earned,
  };
}

function strategy(
  withdrawalSlippage: YieldStrategy["withdrawalSlippage"]
): YieldStrategy {
  return {
    id: "strategy",
    provider: "provider",
    providerReference: "vault",
    name: "Strategy",
    sourceKind: "defi",
    depositMints: ["usdc"],
    liquidityTerm: "instant",
    status: "active",
    hostCluster: "devnet",
    fundable: true,
    depositSlippage: null,
    withdrawalSlippage,
  };
}
