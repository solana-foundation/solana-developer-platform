import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  availableTokens,
  rankedFundableStrategies,
  singleStrategyAllocation,
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

describe("rankedFundableStrategies", () => {
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

  it("shows instant and delayed strategies together, sorted by rate", () => {
    const visible = rankedFundableStrategies(catalogue);
    expect(visible.map((entry) => entry.id)).toEqual([
      "delayed-top",
      "instant-high",
      "instant-low",
      "no-rate",
    ]);
  });

  it("omits strategies whose deposit mint is not a routable stablecoin", () => {
    const visible = rankedFundableStrategies([
      strategy({ id: "unroutable", depositMints: [UNROUTABLE_MINT] }),
    ]);
    expect(visible).toHaveLength(0);
  });

  it("does not mutate the input array", () => {
    const input = [instantLow, instantHigh];
    rankedFundableStrategies(input);
    expect(input.map((entry) => entry.id)).toEqual(["instant-low", "instant-high"]);
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
    // The V1 API caps each lane at one entry and the sum rule pins it to 100,
    // so one entry at 100 is the only valid program shape.
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
