import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import {
  ASSET_DESCRIPTION_MAX_LENGTH,
  buildIssuanceMetadata,
  buildTokenInput,
  getAssetDetailsErrors,
  getDefaultPublicFields,
  getPublicFieldCandidates,
  togglePublicField,
} from "./draft-mapping";
import { createInitialDraft, type DraftState } from "./issuance-draft-wizard.types";

function draftWith(overrides: Partial<DraftState>): DraftState {
  return {
    ...createInitialDraft(),
    assetCategory: "stablecoin",
    assetType: "fiat_backed",
    ...overrides,
  };
}

// A generic asset — the only family where freezeTransfers is "available" rather
// than "locked", so isFreezable is genuinely the issuer's choice.
function genericDraftWith(overrides: Partial<DraftState>): DraftState {
  return draftWith({ assetCategory: "generic", assetType: "generic", ...overrides });
}

const t = (key: MessageKey, values?: TranslationValues) =>
  translate(getMessages("en"), key, values);

describe("getAssetDetailsErrors (description length)", () => {
  it("flags a description longer than the API max", () => {
    const draft = draftWith({ description: "x".repeat(ASSET_DESCRIPTION_MAX_LENGTH + 1) });
    expect(getAssetDetailsErrors(draft, t).description).toBe(
      t("DashboardIssuance.errors.descriptionTooLong", { max: ASSET_DESCRIPTION_MAX_LENGTH })
    );
  });

  it("allows a description exactly at the max", () => {
    const draft = draftWith({ description: "x".repeat(ASSET_DESCRIPTION_MAX_LENGTH) });
    expect(getAssetDetailsErrors(draft, t).description).toBeUndefined();
  });

  it("counts the trimmed length, matching what the client sends to the API", () => {
    // Leading/trailing whitespace is stripped before the request (buildTokenInput
    // and the details-tab save both send draft.description.trim()), so it must not
    // count toward the limit — otherwise the client would over-reject.
    const draft = draftWith({ description: `  ${"x".repeat(ASSET_DESCRIPTION_MAX_LENGTH)}  ` });
    expect(getAssetDetailsErrors(draft, t).description).toBeUndefined();
  });

  it("still requires a non-empty description", () => {
    expect(getAssetDetailsErrors(draftWith({ description: "   " }), t).description).toBe(
      t("DashboardIssuance.errors.descriptionRequired")
    );
  });
});

describe("getAssetDetailsErrors (max supply)", () => {
  it("accepts a blank cap — blank means uncapped, not invalid", () => {
    expect(getAssetDetailsErrors(draftWith({ maxSupply: "   " }), t).maxSupply).toBeUndefined();
  });

  it("accepts a plain positive amount", () => {
    expect(
      getAssetDetailsErrors(draftWith({ maxSupply: "1000000", decimals: "6" }), t).maxSupply
    ).toBeUndefined();
  });

  it.each(["0", "0.00", "abc", "1e6", "-5", "1,000"])("rejects %j", (maxSupply) => {
    expect(getAssetDetailsErrors(draftWith({ maxSupply, decimals: "6" }), t).maxSupply).toBe(
      t("DashboardIssuance.errors.maxSupplyPositive")
    );
  });

  it("rejects more decimal places than the mint can represent", () => {
    // parseDecimalAmount throws on excess scale, so the API would 400 (or, before
    // the service guard, 500). Catch it in the form instead.
    expect(getAssetDetailsErrors(draftWith({ maxSupply: "1.5", decimals: "0" }), t).maxSupply).toBe(
      t("DashboardIssuance.errors.maxSupplyPrecision", { decimals: "0" })
    );
  });

  it("allows precision exactly at the token's decimals", () => {
    expect(
      getAssetDetailsErrors(draftWith({ maxSupply: "1.500", decimals: "3" }), t).maxSupply
    ).toBeUndefined();
  });

  it("skips the precision check while decimals is still invalid", () => {
    // Otherwise a half-typed decimals field would produce a nonsense cap error.
    expect(
      getAssetDetailsErrors(draftWith({ maxSupply: "1.5", decimals: "" }), t).maxSupply
    ).toBeUndefined();
  });
});

describe("buildTokenInput (supply cap)", () => {
  it("omits a blank cap so the API reads it as uncapped", () => {
    // Sending "" would fail the API's decimal-string refinement.
    expect(buildTokenInput(genericDraftWith({ maxSupply: "" })).maxSupply).toBeUndefined();
  });

  it("trims the cap it does send", () => {
    expect(buildTokenInput(genericDraftWith({ maxSupply: " 1000 " })).maxSupply).toBe("1000");
  });
});

describe("buildTokenInput (freeze authority)", () => {
  // isFreezable has no draft field of its own: it is derived from the
  // "freezeAccounts" advanced setting, which is the single control for it.
  it("sends false when a generic issuer selects no freeze setting", () => {
    expect(buildTokenInput(genericDraftWith({})).isFreezable).toBe(false);
  });

  it("sends true once freezeAccounts is selected", () => {
    expect(
      buildTokenInput(genericDraftWith({ advancedSettings: { freezeAccounts: {} } })).isFreezable
    ).toBe(true);
  });

  it("does not infer a freeze authority from pausing alone", () => {
    // Separate mechanisms: the pausable extension pauses the whole mint and has
    // nothing to do with the base mint's freeze authority.
    expect(
      buildTokenInput(genericDraftWith({ advancedSettings: { pauseTransfers: {} } })).isFreezable
    ).toBe(false);
  });

  it("sends true for stablecoins, where freezeAccounts is locked on", () => {
    expect(buildTokenInput(draftWith({ advancedSettings: {} })).isFreezable).toBe(true);
  });

  it("sends true for tokenized securities, where freezeAccounts is locked on", () => {
    expect(
      buildTokenInput(
        draftWith({
          assetCategory: "tokenized_security",
          assetType: "equity",
          advancedSettings: {},
        })
      ).isFreezable
    ).toBe(true);
  });

  it("honours a stored legacy freezeTransfers selection", () => {
    // Drafts saved before the split carry the retired key; it must still grant a
    // freeze authority rather than being pruned as unknown.
    expect(
      buildTokenInput(genericDraftWith({ advancedSettings: { freezeTransfers: {} } })).isFreezable
    ).toBe(true);
  });
});

describe("getDefaultPublicFields", () => {
  it("returns the registry projection for a known type", () => {
    expect(getDefaultPublicFields("stablecoin", "fiat_backed")).toEqual([
      "asset.name",
      "asset.issuerName",
      "asset.pegCurrency",
      "chain.decimals",
      "asset.website",
    ]);
  });

  it("exposes on-chain collateral posture by default for crypto-backed", () => {
    // Crypto-backing's trust comes from transparent collateral, so backing type,
    // collateral assets, and target ratio are public by default.
    expect(getDefaultPublicFields("stablecoin", "crypto_backed")).toEqual([
      "asset.name",
      "asset.pegCurrency",
      "asset.backingType",
      "asset.reserveAsset",
      "asset.collateralizationRatio",
      "chain.decimals",
      "asset.website",
    ]);
  });

  it("returns an empty list for an unknown type", () => {
    expect(getDefaultPublicFields("stablecoin", "not_a_type")).toEqual([]);
  });
});

describe("getPublicFieldCandidates (crypto-backed collateral)", () => {
  it("surfaces the crypto collateral fields with their values", () => {
    const draft = draftWith({
      assetType: "crypto_backed",
      backingType: "crypto",
      reserveAsset: "SOL, wBTC",
      collateralizationRatio: "150",
      oracleProvider: "Pyth",
      publicFields: [],
    });
    const paths = getPublicFieldCandidates(draft, t).map((candidate) => candidate.path);
    expect(paths).toContain("asset.collateralizationRatio");
    expect(paths).toContain("asset.oracleProvider");
    expect(paths).toContain("asset.reserveAsset");
    // Select-backed backingType shows its human label, not the raw value.
    const backing = getPublicFieldCandidates(draft, t).find(
      (candidate) => candidate.path === "asset.backingType"
    );
    expect(backing?.value).toBe("Crypto-backed");
  });
});

describe("togglePublicField", () => {
  it("adds, removes, and dedups paths", () => {
    expect(togglePublicField(["asset.name"], "asset.issuerName", true)).toEqual([
      "asset.name",
      "asset.issuerName",
    ]);
    expect(
      togglePublicField(["asset.name", "asset.issuerName"], "asset.issuerName", false)
    ).toEqual(["asset.name"]);
    expect(togglePublicField(["asset.name"], "asset.name", true)).toEqual(["asset.name"]);
  });
});

describe("getPublicFieldCandidates", () => {
  it("lists only fields with values and reflects their enabled state", () => {
    const draft = draftWith({
      issuerName: "Acme Inc",
      pegCurrency: "USD",
      publicFields: ["asset.issuerName"],
    });
    const candidates = getPublicFieldCandidates(draft, t);

    // Pool order: issuerName before pegCurrency; website (empty) is omitted.
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      "asset.issuerName",
      "asset.pegCurrency",
    ]);
    expect(candidates.find((candidate) => candidate.path === "asset.issuerName")?.enabled).toBe(
      true
    );
    expect(candidates.find((candidate) => candidate.path === "asset.pegCurrency")?.enabled).toBe(
      false
    );
    expect(candidates.find((candidate) => candidate.path === "asset.issuerName")?.value).toBe(
      "Acme Inc"
    );
    expect(candidates.find((candidate) => candidate.path === "asset.issuerName")?.label).toBe(
      "Issuer name"
    );
  });

  it("surfaces the votingRights toggle as an Enabled candidate when on", () => {
    const draft = draftWith({
      assetCategory: "tokenized_security",
      assetType: "equity",
      shareClass: "Class A common",
      votingRights: true,
      publicFields: ["asset.votingRights"],
    });
    const candidate = getPublicFieldCandidates(draft, t).find(
      (entry) => entry.path === "asset.votingRights"
    );
    expect(candidate).toMatchObject({
      label: "Voting rights",
      // Boolean toggle renders a human label, not the literal "true".
      value: "Enabled",
      enabled: true,
    });
  });

  it("omits the votingRights toggle when off", () => {
    const draft = draftWith({
      assetCategory: "tokenized_security",
      assetType: "equity",
      votingRights: false,
    });
    expect(
      getPublicFieldCandidates(draft, t).some((entry) => entry.path === "asset.votingRights")
    ).toBe(false);
  });
});

describe("buildIssuanceMetadata visibility", () => {
  it("omits visibility when the selection matches the type default", () => {
    const draft = draftWith({
      name: "USD Coin",
      issuerName: "Acme Inc",
      pegCurrency: "USD",
      decimals: "6",
      publicFields: getDefaultPublicFields("stablecoin", "fiat_backed"),
    });
    expect(buildIssuanceMetadata(draft)).not.toHaveProperty("visibility");
  });

  it("persists a customized selection (order-independent)", () => {
    const draft = draftWith({
      name: "USD Coin",
      issuerName: "Acme Inc",
      pegCurrency: "USD",
      decimals: "6",
      // issuerName turned off relative to the default.
      publicFields: ["asset.pegCurrency", "asset.name", "chain.decimals"],
    });
    expect(buildIssuanceMetadata(draft).visibility).toEqual({
      public: ["asset.pegCurrency", "asset.name", "chain.decimals"],
    });
  });
});
