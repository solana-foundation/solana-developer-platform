import { describe, expect, it } from "vitest";
import { getDraftDeploymentBlocker } from "../draft-permissions";
import { buildDraftPayload, type DraftState, draftSchema } from "./draft-model";

const draft: DraftState = {
  assetClass: "stablecoin",
  name: "Example USD",
  symbol: "USD",
  description: "",
  website: "",
  maxSupply: "10000000",
  decimals: "6",
  allowlist: false,
  pauseTransfers: true,
  interestBearing: false,
  interestRate: "500",
  transferFee: false,
  transferFeeBasisPoints: "50",
  transferFeeMax: "100",
  authorities: {
    "mint-authority": "wallet-a",
    "metadata-authority": "wallet-a",
    "freeze-authority": "wallet-a",
    "permanent-delegate": "wallet-a",
  },
};

describe("draft creation contract", () => {
  it("maps stablecoin defaults and real wallet IDs without deploying", () => {
    expect(draftSchema.safeParse(draft).success).toBe(true);
    expect(buildDraftPayload(draft)).toMatchObject({
      template: "stablecoin",
      decimals: 6,
      requiresAllowlist: false,
      isFreezable: true,
      signingCustodyWalletId: "wallet-a",
      issuanceMetadata: { custom: { customer: { authorityWalletIds: draft.authorities } } },
    });
    expect(buildDraftPayload(draft)).not.toHaveProperty("mintAddress");
  });
  it("maps a custom asset without stablecoin-only roles", () => {
    const payload = buildDraftPayload({
      ...draft,
      assetClass: "digital-asset",
      decimals: "9",
      maxSupply: "",
      pauseTransfers: false,
    });
    expect(payload).toMatchObject({ template: "custom", decimals: 9, isFreezable: false });
    expect(payload).not.toHaveProperty("maxSupply");
    expect(payload).not.toHaveProperty("issuanceMetadata.settings");
    expect(payload).not.toHaveProperty(
      "issuanceMetadata.custom.customer.authorityWalletIds.freeze-authority"
    );
  });
  it.each([
    { name: "" },
    { symbol: "BAD$" },
    { symbol: ".." },
    { symbol: ".USD" },
    { symbol: "USD." },
    { symbol: "US..D" },
    { description: "x".repeat(501) },
    { decimals: "7" },
    { maxSupply: "-1" },
    { website: "javascript:alert(1)" },
  ])("rejects invalid fields: %o", (patch) => {
    expect(draftSchema.safeParse({ ...draft, ...patch }).success).toBe(false);
  });
  it("accepts the full API decimals range for digital assets", () => {
    for (const decimals of ["0", "9", "18"]) {
      expect(
        draftSchema.safeParse({ ...draft, assetClass: "digital-asset", decimals }).success
      ).toBe(true);
    }
    expect(
      draftSchema.safeParse({ ...draft, assetClass: "digital-asset", decimals: "19" }).success
    ).toBe(false);
  });
  it("blocks deployment rather than silently ignoring different authority wallets", () => {
    expect(getDraftDeploymentBlocker(draft.authorities, "wallet-a")).toBeNull();
    expect(
      getDraftDeploymentBlocker(
        { ...draft.authorities, "freeze-authority": "wallet-b" },
        "wallet-a"
      )
    ).toBe("DashboardIssuance.draftForm.singleSignerRequired");
    expect(getDraftDeploymentBlocker(undefined, undefined)).toBeNull();
  });
});
