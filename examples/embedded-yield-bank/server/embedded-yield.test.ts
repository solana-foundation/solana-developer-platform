import { describe, expect, it, vi } from "vitest";
import type { YieldMovement, YieldStrategy } from "../src/types";
import {
  assertBuiltFeePayer,
  deriveWithdrawalFloor,
  refreshConfirmingMovements,
} from "./embedded-yield";
import { SdpApiError } from "./sdp-client";

describe("Embedded Yield orchestration", () => {
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

  it("refreshes only movements still waiting for confirmation", async () => {
    const submitted = movement("submitted", "submitted");
    const confirmed = movement("confirmed", "confirmed");
    const getMovement = vi
      .fn()
      .mockResolvedValue({ ...submitted, status: "confirmed" });

    await expect(
      refreshConfirmingMovements({ getMovement }, [submitted, confirmed])
    ).resolves.toEqual([{ ...submitted, status: "confirmed" }, confirmed]);
    expect(getMovement).toHaveBeenCalledTimes(1);
    expect(getMovement).toHaveBeenCalledWith(submitted.movementId);
  });

  it("keeps the durable status when a confirmation read is unavailable", async () => {
    const submitted = movement("submitted", "submitted");
    const getMovement = vi.fn().mockRejectedValue(new Error("RPC unavailable"));

    await expect(
      refreshConfirmingMovements({ getMovement }, [submitted])
    ).resolves.toEqual([submitted]);
  });
});

function movement(
  status: YieldMovement["status"],
  movementId: string
): YieldMovement {
  return {
    movementId,
    positionId: "position",
    provider: "provider",
    providerReference: "vault",
    direction: "deposit",
    status,
    signature: "signature",
    amount: "1",
    denomination: "usdc",
    tokenMint: "usdc",
    tokenAmount: "1",
    failureReason: null,
    createdAt: "2026-09-18T00:00:00.000Z",
    settledAt: null,
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
