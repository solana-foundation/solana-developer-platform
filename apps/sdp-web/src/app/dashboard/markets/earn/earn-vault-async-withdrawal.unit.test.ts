import type { EarnVaultWithdrawalOptions } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { earnVaultAsyncWithdrawalRoute } from "./earn-vault-async-withdrawal";

const queueTerms = {
  assetMint: "asset",
  allowWithdrawals: true,
  secondsToMaturity: 60,
  minimumSecondsToDeadline: 300,
  minimumDiscountBps: 10,
  maximumDiscountBps: 100,
  minimumShares: "1",
  shareDecimals: 6,
};

describe("earnVaultAsyncWithdrawalRoute", () => {
  it("maps capabilities to a mechanism without inspecting the provider", () => {
    const options: EarnVaultWithdrawalOptions = {
      positionId: "position_1",
      instant: true,
      queued: true,
      withdrawAuthority: "authority",
      queueState: "queue",
      queueAsset: queueTerms,
    };

    expect(earnVaultAsyncWithdrawalRoute(options)).toEqual({
      kind: "queue",
      summary: {
        messageKey: "DashboardEarn.exitRoute.asyncDescription",
        values: { seconds: 60 },
      },
      terms: queueTerms,
    });
  });

  it("does not advertise a partial or paused queue", () => {
    expect(
      earnVaultAsyncWithdrawalRoute({
        positionId: "position_1",
        instant: true,
        queued: false,
        withdrawAuthority: "authority",
        queueState: "queue",
        queueAsset: queueTerms,
      })
    ).toBeNull();
  });
});
