import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  availableTokens,
  DEFAULT_STRATEGY_SORT,
  nextStrategySort,
  rankedFundableStrategies,
  singleStrategyAllocation,
  sortStrategies,
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

describe("sortStrategies", () => {
  const bigPool = strategy({
    id: "big-pool",
    currentApy: "0.041",
    riskMetadata: { tvlUsd: 22_000_000 },
  });
  const smallPool = strategy({
    id: "small-pool",
    currentApy: "0.058",
    riskMetadata: { tvlUsd: 374_900 },
  });
  const unreportedPool = strategy({ id: "unreported-pool", currentApy: "0.051" });
  const catalogue = [smallPool, unreportedPool, bigPool];

  const ids = (entries: readonly EarnStrategy[]) => entries.map((entry) => entry.id);

  it("ranks by pool size, largest first", () => {
    expect(ids(sortStrategies(catalogue, { column: "pool", direction: "desc" }))).toEqual([
      "big-pool",
      "small-pool",
      "unreported-pool",
    ]);
  });

  it("reverses to smallest first on the ascending pass", () => {
    expect(ids(sortStrategies(catalogue, { column: "pool", direction: "asc" }))).toEqual([
      "small-pool",
      "big-pool",
      "unreported-pool",
    ]);
  });

  it("keeps an unreported figure last in both directions", () => {
    // A row rendering "—" is the row we know least about; ascending must not
    // promote it above every strategy the reader can actually compare.
    const rateless = [strategy({ id: "no-rate", currentApy: undefined }), bigPool, smallPool];
    for (const direction of ["asc", "desc"] as const) {
      expect(ids(sortStrategies(catalogue, { column: "pool", direction })).at(-1)).toBe(
        "unreported-pool"
      );
      expect(ids(sortStrategies(rateless, { column: "apy", direction })).at(-1)).toBe("no-rate");
    }
  });

  it("breaks ties on name, so a re-read cannot shuffle equal rows", () => {
    const tied = [
      strategy({ id: "gauntlet", name: "Kamino Gauntlet USDC", currentApy: "0.051" }),
      strategy({ id: "allez", name: "Kamino Allez USDC", currentApy: "0.051" }),
    ];
    const order = ids(sortStrategies(tied, { column: "apy", direction: "desc" }));
    expect(order).toEqual(["allez", "gauntlet"]);
    // Same answer whichever order the provider happened to report them in.
    expect(ids(sortStrategies([...tied].reverse(), { column: "apy", direction: "desc" }))).toEqual(
      order
    );
  });

  it("does not mutate the input array", () => {
    const input = [smallPool, bigPool];
    sortStrategies(input, { column: "pool", direction: "desc" });
    expect(ids(input)).toEqual(["small-pool", "big-pool"]);
  });

  it("is a no-op on a list already in the default order", () => {
    const ranked = rankedFundableStrategies(catalogue);
    expect(ids(sortStrategies(ranked, DEFAULT_STRATEGY_SORT))).toEqual(ids(ranked));
  });
});

describe("nextStrategySort", () => {
  it("opens a newly clicked column at descending", () => {
    expect(nextStrategySort({ column: "apy", direction: "asc" }, "pool")).toEqual({
      column: "pool",
      direction: "desc",
    });
  });

  it("flips the direction of the active column", () => {
    const flipped = nextStrategySort(DEFAULT_STRATEGY_SORT, "apy");
    expect(flipped).toEqual({ column: "apy", direction: "asc" });
    expect(nextStrategySort(flipped, "apy")).toEqual(DEFAULT_STRATEGY_SORT);
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
