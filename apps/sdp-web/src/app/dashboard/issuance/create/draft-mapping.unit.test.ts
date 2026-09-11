import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import {
  ASSET_DESCRIPTION_MAX_LENGTH,
  buildIssuanceMetadata,
  getAssetDetailsErrors,
  getDefaultPublicFields,
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
    // Leading/trailing whitespace is stripped before the details-tab save, so it must not
    // count toward the limit — otherwise the client would over-reject.
    const draft = draftWith({ description: `  ${"x".repeat(ASSET_DESCRIPTION_MAX_LENGTH)}  ` });
    expect(getAssetDetailsErrors(draft, t).description).toBeUndefined();
  });

  it("allows an optional description, matching creation", () => {
    expect(getAssetDetailsErrors(draftWith({ description: "   " }), t).description).toBeUndefined();
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
