import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import {
  capacityHasConfig,
  type DetailFieldKey,
  defaultCapacityConfig,
  detailSectionsHaveField,
  getDetailSections,
  impliedBackingType,
  summarizeCapacityConfig,
} from "./asset-details-config";

const messages = getMessages("en");
const t = (key: MessageKey, values?: TranslationValues) => translate(messages, key, values);

function fieldKeys(
  category: Parameters<typeof getDetailSections>[0],
  type: string
): DetailFieldKey[] {
  return getDetailSections(category, type).flatMap((section) =>
    section.fields.map((field) => field.key)
  );
}

describe("getDetailSections", () => {
  it("gives fiat- and crypto-backed stablecoins different fields", () => {
    const fiat = fieldKeys("stablecoin", "fiat_backed");
    const crypto = fieldKeys("stablecoin", "crypto_backed");

    // Crypto-backing adds a collateral & oracle section absent from fiat.
    expect(crypto).toContain("collateralizationRatio");
    expect(crypto).toContain("oracleProvider");
    expect(crypto).toContain("minCollateralRatio");
    expect(fiat).not.toContain("collateralizationRatio");
  });

  it("omits the manual backing-type select for typed stablecoins (it's implied)", () => {
    expect(fieldKeys("stablecoin", "fiat_backed")).not.toContain("backingType");
    expect(fieldKeys("stablecoin", "crypto_backed")).not.toContain("backingType");
    // A generic stablecoin has no implied backing, so it keeps the select.
    expect(fieldKeys("stablecoin", "generic")).toContain("backingType");
  });

  it("gives each tokenized-security sub-type its own instrument terms", () => {
    expect(fieldKeys("tokenized_security", "equity")).toContain("shareClass");
    expect(fieldKeys("tokenized_security", "debt")).toContain("couponRate");
    expect(fieldKeys("tokenized_security", "debt")).toContain("maturityDate");
    expect(fieldKeys("tokenized_security", "fund")).toContain("managementFee");
    // Terms don't leak across sub-types.
    expect(fieldKeys("tokenized_security", "equity")).not.toContain("couponRate");
  });

  it("differentiates generic sub-types (real estate vs commodity)", () => {
    expect(fieldKeys("generic", "real_estate")).toContain("propertyType");
    expect(fieldKeys("generic", "real_estate")).toContain("propertyLocation");
    expect(fieldKeys("generic", "commodity")).toContain("underlyingAsset");
    expect(fieldKeys("generic", "commodity")).not.toContain("propertyType");
  });

  it("falls back to the category default before a type is chosen", () => {
    expect(getDetailSections("stablecoin", null).length).toBeGreaterThan(0);
    expect(getDetailSections(null, null)).toEqual([]);
  });
});

describe("detailSectionsHaveField", () => {
  it("reports peg collection for stablecoins but not securities", () => {
    expect(detailSectionsHaveField("stablecoin", "crypto_backed", "pegCurrency")).toBe(true);
    expect(detailSectionsHaveField("tokenized_security", "equity", "pegCurrency")).toBe(false);
  });
});

describe("impliedBackingType", () => {
  it("maps typed stablecoins to their backing and leaves others unimplied", () => {
    expect(impliedBackingType("stablecoin", "fiat_backed")).toBe("fiat");
    expect(impliedBackingType("stablecoin", "crypto_backed")).toBe("crypto");
    expect(impliedBackingType("stablecoin", "generic")).toBeNull();
    expect(impliedBackingType("tokenized_security", "equity")).toBeNull();
    expect(impliedBackingType(null, null)).toBeNull();
  });
});

describe("capacity config", () => {
  it("marks only the four policies with a config form as configurable", () => {
    expect(capacityHasConfig("restrictTradingHours")).toBe(true);
    expect(capacityHasConfig("transferApprovals")).toBe(true);
    expect(capacityHasConfig("redemptionApprovals")).toBe(true);
    expect(capacityHasConfig("investorReporting")).toBe(true);
    // Roster/authority and pure-commitment policies stay declaration-only.
    expect(capacityHasConfig("kyc")).toBe(false);
    expect(capacityHasConfig("issueRetireControls")).toBe(false);
  });

  it("returns a sensible default only for configurable policies", () => {
    expect(defaultCapacityConfig("restrictTradingHours")).toEqual({ schedule: "market_hours" });
    expect(defaultCapacityConfig("transferApprovals")).toEqual({ rule: "all" });
    expect(defaultCapacityConfig("redemptionApprovals")).toEqual({ rule: "all" });
    expect(defaultCapacityConfig("investorReporting")).toEqual({ cadence: "quarterly" });
    expect(defaultCapacityConfig("kyc")).toBeUndefined();
  });

  it("summarizes each policy's config, and returns null when unconfigured", () => {
    expect(summarizeCapacityConfig("transferApprovals", undefined, t)).toBeNull();
    expect(summarizeCapacityConfig("kyc", undefined, t)).toBeNull();

    expect(summarizeCapacityConfig("restrictTradingHours", { schedule: "market_hours" }, t)).toBe(
      "Market hours"
    );
    expect(
      summarizeCapacityConfig("transferApprovals", { rule: "above_amount", amount: "10000" }, t)
    ).toBe("Above 10000 tokens");
    expect(summarizeCapacityConfig("redemptionApprovals", { rule: "all" }, t)).toBe(
      "All redemptions"
    );
    expect(
      summarizeCapacityConfig("investorReporting", { cadence: "quarterly", format: "pdf" }, t)
    ).toBe("Quarterly · PDF");
    expect(summarizeCapacityConfig("investorReporting", { cadence: "annual" }, t)).toBe("Annual");
  });
});
