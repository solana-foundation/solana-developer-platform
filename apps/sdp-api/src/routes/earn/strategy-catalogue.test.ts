import {
  earnStrategyParticipationOverridesSchema,
  earnStrategyParticipationSchema,
} from "@sdp/types/earn-participation";
import { EARN_PROVIDERS, earnStrategyParticipation } from "@sdp/types/provider-access";
import { describe, expect, it } from "vitest";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { mapToEarnStrategy } from "./strategy-catalogue";

const hastraRow: EarnStrategyRow = {
  id: "earn_strategy_hastra_prime",
  provider: "hastra",
  provider_reference: "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7",
  name: "Hastra PRIME",
  source_kind: "rwa",
  underlying_source: "figure-democratized-prime-home-equity",
  deposit_mints: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
  share_mint: "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7",
  apy_type: "variable",
  current_apy: null,
  liquidity_term: "delayed",
  redemption_delay_days: null,
  risk_metadata: {},
  status: "active",
  catalogue_delisted_at: null,
  host_cluster: "mainnet-beta",
  environment: "production",
  created_at: "2026-09-22T00:00:00.000Z",
  updated_at: "2026-09-22T00:00:00.000Z",
};

describe("mapToEarnStrategy Hastra withdrawal metadata", () => {
  it("publishes no DEX floor by default or when the Jupiter key is missing", () => {
    expect(mapToEarnStrategy(hastraRow, "production", {}).withdrawalSlippage).toBeNull();
    expect(
      mapToEarnStrategy(hastraRow, "production", {
        EARN_HASTRA_DEX_EXIT_ENABLED: "true",
      }).withdrawalSlippage
    ).toBeNull();
  });

  it("publishes the DEX floor only when the optional rail is fully configured", () => {
    expect(
      mapToEarnStrategy(hastraRow, "production", {
        EARN_HASTRA_DEX_EXIT_ENABLED: "true",
        JUPITER_SWAP_API_KEY: "jup_test_key",
      }).withdrawalSlippage
    ).toEqual({ quoteRequired: true, defaultToleranceBps: 50 });
  });
});

describe("strategy participation metadata", () => {
  it.each(EARN_PROVIDERS)("declares all participation fields for %s", (provider) => {
    const metadata = earnStrategyParticipationSchema.parse(earnStrategyParticipation(provider));
    expect(Object.keys(metadata).sort()).toEqual([
      "geographicallyRestricted",
      "requiresKyb",
      "requiresKyc",
      "termsUrl",
    ]);
    expect(metadata.termsUrl).toMatch(/^https:\/\//);
  });

  it("reports confirmed WisdomTree requirements without claiming wallet approval", () => {
    expect(earnStrategyParticipation("wisdomtree")).toEqual({
      requiresKyc: true,
      requiresKyb: true,
      geographicallyRestricted: true,
      termsUrl: "https://app.wisdomtreeconnect.com/web/order/terms-and-conditions",
    });
  });

  it("keeps unknown provider requirements unknown", () => {
    expect(earnStrategyParticipation("unregistered-provider")).toEqual({
      requiresKyc: null,
      requiresKyb: null,
      geographicallyRestricted: null,
      termsUrl: null,
    });
  });

  it("does not infer no KYC from permissionless execution or a missing live check", () => {
    for (const provider of ["veda", "kamino", "jupiter_lend", "ondo", "hastra", "plume"]) {
      expect(earnStrategyParticipation(provider).requiresKyc).toBeNull();
      expect(earnStrategyParticipation(provider).requiresKyb).toBeNull();
    }
  });

  it("preserves explicit false and unknown strategy overrides over provider defaults", () => {
    const strategy = mapToEarnStrategy(
      {
        ...hastraRow,
        provider: "wisdomtree",
        risk_metadata: {
          participation: {
            requiresKyc: false,
            requiresKyb: null,
            geographicallyRestricted: null,
            termsUrl: null,
          },
        },
      },
      "production",
      {}
    );
    expect(strategy).toMatchObject({
      requiresKyc: false,
      requiresKyb: null,
      geographicallyRestricted: null,
      termsUrl: null,
    });
  });

  it("lets one strategy override a provider document without dropping other requirements", () => {
    expect(
      earnStrategyParticipation("wisdomtree", {
        termsUrl: "https://example.com/fund-terms",
        requiresKyb: undefined,
      })
    ).toMatchObject({
      requiresKyc: true,
      requiresKyb: true,
      geographicallyRestricted: true,
      termsUrl: "https://example.com/fund-terms",
    });
  });

  it.each(["javascript:alert(1)", "data:text/html,test", "http://example.com/terms"])(
    "refuses an unsafe terms URL: %s",
    (termsUrl) => {
      expect(earnStrategyParticipationOverridesSchema.safeParse({ termsUrl }).success).toBe(false);
    }
  );

  it("does not coerce unknown requirement text to false", () => {
    expect(
      earnStrategyParticipationOverridesSchema.safeParse({ requiresKyc: "false" }).success
    ).toBe(false);
    expect(earnStrategyParticipationSchema.safeParse({ termsUrl: null }).success).toBe(false);
  });
});
