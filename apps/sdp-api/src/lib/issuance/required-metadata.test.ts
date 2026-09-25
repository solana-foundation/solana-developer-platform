import type { IssuanceMetadata } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  assertRequiredForDeployMetadata,
  validateRequiredForDeployMetadata,
} from "./required-metadata";

const COMPLETE_FIAT = { asset: { name: "USD Coin", issuerName: "Acme Inc", pegCurrency: "USD" } };

describe("validateRequiredForDeployMetadata", () => {
  it("reports every registry-required field that is missing, blank, or null", () => {
    const BOTH = [
      { field: "asset.issuerName", reason: "required" },
      { field: "asset.pegCurrency", reason: "required" },
    ];
    const cases: Array<{ issuanceMetadata: IssuanceMetadata; expected: typeof BOTH }> = [
      { issuanceMetadata: {}, expected: BOTH },
      { issuanceMetadata: { asset: {} }, expected: BOTH },
      {
        issuanceMetadata: { asset: { issuerName: null, pegCurrency: "USD" } },
        expected: [{ field: "asset.issuerName", reason: "required" }],
      },
      {
        issuanceMetadata: { asset: { issuerName: "   ", pegCurrency: "USD" } },
        expected: [{ field: "asset.issuerName", reason: "required" }],
      },
      {
        issuanceMetadata: { asset: { issuerName: "Acme Inc", pegCurrency: "" } },
        expected: [{ field: "asset.pegCurrency", reason: "required" }],
      },
    ];
    for (const { issuanceMetadata, expected } of cases) {
      const errors = validateRequiredForDeployMetadata(
        "stablecoin",
        "fiat_backed",
        issuanceMetadata
      );
      expect(errors, JSON.stringify(issuanceMetadata)).toEqual(expected);
    }
  });

  it("treats non-string required values as unsupplied (fail closed)", () => {
    // The metadata schema is intentionally open: objects, arrays, booleans,
    // and numbers all pass schema validation, so the gate itself must treat
    // any non-string required value as unsupplied.
    const cases: Array<{ asset: Record<string, unknown>; expectedField: string }> = [
      { asset: { issuerName: {}, pegCurrency: "USD" }, expectedField: "asset.issuerName" },
      { asset: { issuerName: "Acme Inc", pegCurrency: false }, expectedField: "asset.pegCurrency" },
      {
        asset: { issuerName: ["Acme Inc"], pegCurrency: "USD" },
        expectedField: "asset.issuerName",
      },
      { asset: { issuerName: 42, pegCurrency: "USD" }, expectedField: "asset.issuerName" },
    ];
    for (const { asset, expectedField } of cases) {
      const errors = validateRequiredForDeployMetadata("stablecoin", "fiat_backed", { asset });
      expect(errors, JSON.stringify(asset)).toEqual([{ field: expectedField, reason: "required" }]);
    }
  });

  it("accepts a profile that satisfies the registry (compatibility)", () => {
    expect(validateRequiredForDeployMetadata("stablecoin", "fiat_backed", COMPLETE_FIAT)).toEqual(
      []
    );
  });

  it("ignores types that declare no requiredForDeploy fields (compatibility)", () => {
    expect(validateRequiredForDeployMetadata("stablecoin", "generic", {})).toEqual([]);
    expect(validateRequiredForDeployMetadata("stablecoin", "crypto_backed", {})).toEqual([]);
  });

  it("ignores unknown category/type pairs (callers validate the pair separately)", () => {
    expect(validateRequiredForDeployMetadata("stablecoin", "not_a_type", {})).toEqual([]);
  });

  it("treats absent metadata like an empty object", () => {
    expect(validateRequiredForDeployMetadata("stablecoin", "fiat_backed", undefined)).toEqual([
      { field: "asset.issuerName", reason: "required" },
      { field: "asset.pegCurrency", reason: "required" },
    ]);
  });
});

describe("assertRequiredForDeployMetadata", () => {
  it("throws a field-specific bad request listing every unmet field", () => {
    expect(() =>
      assertRequiredForDeployMetadata("stablecoin", "fiat_backed", { asset: { issuerName: "  " } })
    ).toThrowError(/asset\.issuerName.*asset\.pegCurrency/);
  });

  it("does not throw when the registry is satisfied", () => {
    expect(() =>
      assertRequiredForDeployMetadata("stablecoin", "fiat_backed", COMPLETE_FIAT)
    ).not.toThrow();
  });
});
