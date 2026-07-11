import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import {
  buildIssuanceMetadata,
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

const t = (key: MessageKey, values?: TranslationValues) =>
  translate(getMessages("en"), key, values);

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

  it("returns an empty list for an unknown type", () => {
    expect(getDefaultPublicFields("stablecoin", "not_a_type")).toEqual([]);
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
