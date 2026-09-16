import { describe, expect, it } from "vitest";
import { buildDefaultAssetProfile } from "./default-asset-profile";

describe("buildDefaultAssetProfile", () => {
  it("preserves legacy token capabilities as editable advanced settings", () => {
    const profile = buildDefaultAssetProfile({
      name: "Legacy USD",
      description: "Migrated token",
      decimals: 6,
      template: "custom",
      isFreezable: true,
      extensions: {
        pausable: { authority: "pause-authority" },
        permanentDelegate: "delegate-authority",
        transferFee: {
          basisPoints: 25,
          maxFee: "100",
          transferFeeConfigAuthority: "fee-authority",
          withdrawWithheldAuthority: "withdraw-authority",
        },
      },
    });

    expect(profile.issuanceMetadata.settings).toEqual({
      version: 1,
      selected: {
        pauseTransfers: {},
        freezeAccounts: {},
        permanentDelegate: {},
        transferFee: { params: { basisPoints: 25, maxFee: "100" } },
      },
    });
  });
});
