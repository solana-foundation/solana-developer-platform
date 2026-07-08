import type { IssuanceMetadata } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { projectPublicMetadata } from "./public-metadata";

// Fiat-backed stablecoin registry publicProjection:
// ["asset.name", "asset.issuerName", "asset.pegCurrency", "chain.decimals", "asset.website"].
const baseMetadata: IssuanceMetadata = {
  asset: {
    name: "USD Coin",
    issuerName: "Acme Inc",
    pegCurrency: "USD",
    website: "https://acme.example",
    custodian: "Acme Custody",
  },
  compliance: { accessControl: "blocklist", capacities: { kyc: true } },
  chain: { decimals: 6 },
  custom: { customer: { secret: "nope" } },
};

describe("projectPublicMetadata", () => {
  it("falls back to the registry projection when visibility is absent", () => {
    const result = projectPublicMetadata("stablecoin", "fiat_backed", baseMetadata);
    expect(result).toEqual({
      asset: {
        name: "USD Coin",
        issuerName: "Acme Inc",
        pegCurrency: "USD",
        website: "https://acme.example",
      },
      chain: { decimals: 6 },
    });
  });

  it("projects exactly the issuer-selected public paths", () => {
    const result = projectPublicMetadata("stablecoin", "fiat_backed", {
      ...baseMetadata,
      visibility: { public: ["asset.name", "asset.issuerName"] },
    });
    expect(result).toEqual({ asset: { name: "USD Coin", issuerName: "Acme Inc" } });
    expect(result.asset).not.toHaveProperty("pegCurrency");
  });

  it("allows asset.* fields beyond the registry default (broad pool)", () => {
    const result = projectPublicMetadata("stablecoin", "fiat_backed", {
      ...baseMetadata,
      visibility: { public: ["asset.website", "asset.custodian"] },
    });
    expect(result).toEqual({
      asset: { website: "https://acme.example", custodian: "Acme Custody" },
    });
  });

  it("never projects compliance.* or custom.* even if requested", () => {
    const result = projectPublicMetadata("stablecoin", "fiat_backed", {
      ...baseMetadata,
      visibility: {
        public: [
          "asset.name",
          "compliance.accessControl",
          "custom.customer.secret",
          "visibility.public",
        ],
      },
    });
    expect(result).toEqual({ asset: { name: "USD Coin" } });
    expect(result).not.toHaveProperty("compliance");
    expect(result).not.toHaveProperty("custom");
  });

  it("treats an explicit empty selection as everything private", () => {
    const result = projectPublicMetadata("stablecoin", "fiat_backed", {
      ...baseMetadata,
      visibility: { public: [] },
    });
    expect(result).toEqual({});
  });

  it("skips absent paths and ignores non-string entries", () => {
    const result = projectPublicMetadata("stablecoin", "fiat_backed", {
      asset: { name: "USD Coin" },
      visibility: { public: ["asset.name", "asset.issuerName", 42 as unknown as string] },
    });
    expect(result).toEqual({ asset: { name: "USD Coin" } });
  });

  it("returns an empty object for an unknown asset type", () => {
    expect(projectPublicMetadata("stablecoin", "not_a_type", baseMetadata)).toEqual({});
  });
});
