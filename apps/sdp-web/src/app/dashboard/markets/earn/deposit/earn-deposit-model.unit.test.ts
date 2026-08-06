import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  availableTokens,
  EARN_DEPOSIT_PROFILES,
  matchesFilters,
  profileFilters,
  profileSummaries,
  singleStrategyAllocation,
  visibleStrategies,
} from "./earn-deposit-model";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const UNROUTABLE_MINT = "So11111111111111111111111111111111111111112";

function strategy(partial: Partial<EarnStrategy> & { id: string }): EarnStrategy {
  return {
    provider: "ground",
    providerReference: `${partial.id}-ref`,
    name: partial.id,
    sourceKind: "defi",
    depositMints: [USDC],
    apyType: "variable",
    currentApy: "0.05",
    liquidityTerm: "instant",
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...partial,
  };
}

describe("profileFilters", () => {
  it("maps liquidity-first to instant-only redemption", () => {
    expect(profileFilters("liquidity").maxSettlementDays).toBe(0);
  });

  it("maps balanced to a short settlement ceiling", () => {
    expect(profileFilters("balanced").maxSettlementDays).toBe(3);
  });

  it("leaves yield-first unconstrained on both axes", () => {
    const filters = profileFilters("yield");
    expect(filters.maxSettlementDays).toBeNull();
    expect(filters.minPoolUsd).toBeNull();
  });

  it("starts every profile sorted by rate and open to any stablecoin", () => {
    for (const profile of EARN_DEPOSIT_PROFILES) {
      expect(profileFilters(profile).sort).toBe("apy");
      expect(profileFilters(profile).token).toBeNull();
    }
  });
});

describe("matchesFilters", () => {
  it("excludes a delayed strategy from an instant-only filter", () => {
    const delayed = strategy({ id: "a", liquidityTerm: "delayed", redemptionDelayDays: 2 });
    expect(matchesFilters(delayed, profileFilters("liquidity"))).toBe(false);
    expect(matchesFilters(delayed, profileFilters("balanced"))).toBe(true);
  });

  it("treats a delayed strategy with no day count as T+1", () => {
    const delayed = strategy({ id: "a", liquidityTerm: "delayed" });
    expect(matchesFilters(delayed, { ...profileFilters("yield"), maxSettlementDays: 0 })).toBe(
      false
    );
    expect(matchesFilters(delayed, { ...profileFilters("yield"), maxSettlementDays: 1 })).toBe(
      true
    );
  });

  it("excludes a pool smaller than the floor", () => {
    const small = strategy({ id: "a", riskMetadata: { tvlUsd: 1_000 } });
    expect(matchesFilters(small, profileFilters("liquidity"))).toBe(false);
  });

  it("never excludes on an unreported pool size", () => {
    // Ground's sandbox routinely omits tvlUsd; a floor must not empty the
    // catalogue just because the provider stayed silent.
    const unknownPool = strategy({ id: "a", riskMetadata: {} });
    expect(matchesFilters(unknownPool, profileFilters("liquidity"))).toBe(true);
  });

  it("filters on backing kind and stablecoin", () => {
    const rwa = strategy({ id: "a", sourceKind: "rwa" });
    const base = profileFilters("yield");
    expect(matchesFilters(rwa, { ...base, sourceKind: "rwa" })).toBe(true);
    expect(matchesFilters(rwa, { ...base, sourceKind: "defi" })).toBe(false);
    expect(matchesFilters(rwa, { ...base, token: "usdc" })).toBe(true);
    expect(matchesFilters(rwa, { ...base, token: "usdt" })).toBe(false);
  });
});

describe("visibleStrategies", () => {
  const instantHigh = strategy({ id: "instant-high", currentApy: "0.09" });
  const instantLow = strategy({ id: "instant-low", currentApy: "0.03" });
  const delayedTop = strategy({
    id: "delayed-top",
    currentApy: "0.12",
    liquidityTerm: "delayed",
    redemptionDelayDays: 5,
  });
  const noRate = strategy({ id: "no-rate", currentApy: undefined });
  const catalogue = [instantLow, delayedTop, noRate, instantHigh];

  it("sorts by rate descending with unrated strategies last", () => {
    const visible = visibleStrategies(catalogue, profileFilters("yield"));
    expect(visible.map((entry) => entry.id)).toEqual([
      "delayed-top",
      "instant-high",
      "instant-low",
      "no-rate",
    ]);
  });

  it("sorts by fastest access, breaking ties on rate", () => {
    const visible = visibleStrategies(catalogue, {
      ...profileFilters("yield"),
      sort: "access",
    });
    expect(visible.map((entry) => entry.id)).toEqual([
      "instant-high",
      "instant-low",
      "no-rate",
      "delayed-top",
    ]);
  });

  it("drops the highest rate when the profile requires instant access", () => {
    const visible = visibleStrategies(catalogue, profileFilters("liquidity"));
    expect(visible.map((entry) => entry.id)).not.toContain("delayed-top");
  });

  it("omits strategies whose deposit mint is not a routable stablecoin", () => {
    const visible = visibleStrategies(
      [strategy({ id: "unroutable", depositMints: [UNROUTABLE_MINT] })],
      profileFilters("yield")
    );
    expect(visible).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const input = [instantLow, instantHigh];
    visibleStrategies(input, profileFilters("yield"));
    expect(input.map((entry) => entry.id)).toEqual(["instant-low", "instant-high"]);
  });
});

describe("profileSummaries", () => {
  it("reports the live count and best rate reachable per profile", () => {
    const summaries = profileSummaries([
      strategy({ id: "instant", currentApy: "0.04" }),
      strategy({
        id: "delayed",
        currentApy: "0.11",
        liquidityTerm: "delayed",
        redemptionDelayDays: 10,
      }),
    ]);
    const byProfile = new Map(summaries.map((entry) => [entry.profile, entry]));

    expect(byProfile.get("liquidity")).toMatchObject({ count: 1, topApy: 0.04 });
    expect(byProfile.get("yield")).toMatchObject({ count: 2, topApy: 0.11 });
    expect(byProfile.get("liquidity")?.fastestSettlementDays).toBe(0);
    expect(byProfile.get("yield")?.fastestSettlementDays).toBe(0);
  });

  it("reports an empty profile without inventing a rate", () => {
    const summaries = profileSummaries([
      strategy({ id: "delayed", liquidityTerm: "delayed", redemptionDelayDays: 30 }),
    ]);
    const liquidity = summaries.find((entry) => entry.profile === "liquidity");
    expect(liquidity).toMatchObject({ count: 0, topApy: undefined });
    expect(liquidity?.fastestSettlementDays).toBeUndefined();
  });
});

describe("availableTokens", () => {
  it("returns only stablecoins the catalogue can actually fund", () => {
    expect(
      availableTokens([
        strategy({ id: "a", depositMints: [USDC] }),
        strategy({ id: "b", depositMints: [USDC] }),
        strategy({ id: "c", depositMints: [UNROUTABLE_MINT] }),
      ])
    ).toEqual(["usdc"]);
  });

  it("reports both lanes when both are present", () => {
    const tokens = availableTokens([
      strategy({ id: "a", depositMints: [USDC] }),
      strategy({ id: "b", depositMints: [USDT] }),
    ]);
    expect([...tokens].sort()).toEqual(["usdc", "usdt"]);
  });
});

describe("singleStrategyAllocation", () => {
  it("puts the whole stablecoin lane into the chosen strategy", () => {
    // The API validates weights on a 0.1 grid summing to exactly 100 per lane,
    // so one entry at 100 is the minimal valid program.
    expect(
      singleStrategyAllocation(
        strategy({ id: "a", providerReference: "morpho-gauntlet-usdc", depositMints: [USDC] })
      )
    ).toEqual({ usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", pct: 100 }] });
  });

  it("keys the allocation to the provider reference, not the SDP id", () => {
    const allocation = singleStrategyAllocation(
      strategy({ id: "earn_strategy_1", providerReference: "syrup-usdc" })
    );
    expect(allocation?.usdc?.[0]?.yieldSourceId).toBe("syrup-usdc");
  });

  it("targets the USDT lane for a USDT strategy, leaving USDC untouched", () => {
    const allocation = singleStrategyAllocation(strategy({ id: "a", depositMints: [USDT] }));
    expect(allocation?.usdt).toHaveLength(1);
    expect(allocation?.usdc).toBeUndefined();
  });

  it("returns undefined when no deposit mint maps to a stablecoin lane", () => {
    expect(
      singleStrategyAllocation(strategy({ id: "a", depositMints: [UNROUTABLE_MINT] }))
    ).toBeUndefined();
  });
});
