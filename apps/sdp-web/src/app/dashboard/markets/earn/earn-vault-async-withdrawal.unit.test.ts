import type { EarnVaultWithdrawalOptions } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { earnVaultAsyncWithdrawalRoute } from "./earn-vault-async-withdrawal";

const queueTerms = {
  assetMint: "asset",
  allowWithdrawals: true,
  secondsToMaturity: 60,
  minimumSecondsToDeadline: 300,
  maximumSecondsToDeadline: 7_776_000,
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
      providerOrder: false,
      queued: true,
      withdrawAuthority: "authority",
      queueState: "queue",
      queueAsset: queueTerms,
    };

    expect(earnVaultAsyncWithdrawalRoute(options)).toEqual({
      kind: "queue",
      summary: {
        titleKey: "DashboardEarn.exitRoute.asyncTitle",
        messageKey: "DashboardEarn.exitRoute.asyncDescription",
        values: {},
      },
      waitSeconds: 60,
      terms: queueTerms,
    });
  });

  it("does not advertise a partial or paused queue", () => {
    expect(
      earnVaultAsyncWithdrawalRoute({
        positionId: "position_1",
        instant: true,
        providerOrder: false,
        queued: false,
        withdrawAuthority: "authority",
        queueState: "queue",
        queueAsset: queueTerms,
      })
    ).toBeNull();
  });

  it("maps a delayed provider order without advertising an instant payout", () => {
    expect(
      earnVaultAsyncWithdrawalRoute({
        positionId: "position_1",
        instant: false,
        providerOrder: true,
        queued: false,
        withdrawAuthority: null,
        queueState: null,
        queueAsset: null,
      })
    ).toEqual({
      kind: "provider_order",
      summary: {
        titleKey: "DashboardEarn.exitRoute.providerOrderTitle",
        messageKey: "DashboardEarn.exitRoute.providerOrderDescription",
        values: {},
      },
    });
  });

  it("maps an operator-settled par redemption independently of instant liquidity", () => {
    const parRedemption = {
      intermediateMint: "wylds",
      assetMint: "usdc",
      minimumShares: "2000",
      shareDecimals: 6,
      assetDecimals: 6,
      cancelable: true,
      operatorSettled: true as const,
    };
    expect(
      earnVaultAsyncWithdrawalRoute({
        positionId: "position_1",
        instant: false,
        providerOrder: false,
        queued: false,
        withdrawAuthority: null,
        queueState: null,
        queueAsset: null,
        parRedemption,
      })
    ).toEqual({
      kind: "operator_redemption",
      summary: {
        titleKey: "DashboardEarn.exitRoute.parTitle",
        messageKey: "DashboardEarn.exitRoute.parDescription",
        values: {},
      },
      terms: parRedemption,
    });
  });

  it("fails closed instead of silently preferring one of two delayed mechanisms", () => {
    expect(
      earnVaultAsyncWithdrawalRoute({
        positionId: "position_1",
        instant: false,
        providerOrder: true,
        queued: true,
        withdrawAuthority: "authority",
        queueState: "queue",
        queueAsset: queueTerms,
      })
    ).toBeNull();
  });

  it("fails closed when par redemption overlaps another delayed contract", () => {
    expect(
      earnVaultAsyncWithdrawalRoute({
        positionId: "position_1",
        instant: false,
        providerOrder: true,
        queued: false,
        withdrawAuthority: null,
        queueState: null,
        queueAsset: null,
        parRedemption: {
          intermediateMint: "wylds",
          assetMint: "usdc",
          minimumShares: "2000",
          shareDecimals: 6,
          assetDecimals: 6,
          cancelable: true,
          operatorSettled: true,
        },
      })
    ).toBeNull();
  });
});
