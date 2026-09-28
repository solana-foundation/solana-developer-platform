import { describe, expect, it } from "vitest";
import type { EarnStrategyRow } from "@/db/repositories";
import { mapToEarnStrategy } from "./strategies";

const hastraRow: EarnStrategyRow = {
  id: "earn_strategy_hastra_prime",
  provider: "hastra",
  provider_reference: "3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7",
  name: "Hastra PRIME",
  source_kind: "rwa",
  underlying_source: "figure-democratized-prime-heloc",
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
