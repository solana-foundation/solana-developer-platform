import { describe, expect, it } from "vitest";
import {
  type DetailFieldKey,
  detailSectionsHaveField,
  getDetailSections,
  impliedBackingType,
} from "./asset-details-config";

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
    expect(crypto).toContain("liquidationThreshold");
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
