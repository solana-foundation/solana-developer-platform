import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  availableTokens,
  DEFAULT_STRATEGY_SORT,
  fundableStrategies,
  nextStrategySort,
  opportunityDepositability,
  rankedFundableStrategies,
  rankedStrategies,
  singleStrategyAllocation,
  sortStrategies,
  strategyDepositEligibility,
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
    hostCluster: "devnet",
    fundable: true,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...partial,
  };
}

describe("fundableStrategies", () => {
  it("drops a strategy whose deposit mint is not a routable stablecoin", () => {
    const kept = strategy({ id: "usdc" });
    const dropped = strategy({ id: "sol", depositMints: [UNROUTABLE_MINT] });

    expect(fundableStrategies([kept, dropped]).map((s) => s.id)).toEqual(["usdc"]);
  });

  /**
   * The devnet-money guard, dashboard side. `fundable` is the API's per-request
   * answer to "does this instrument exist on the caller's cluster", and the
   * wizard must never offer a `false` one or a user walks to a confirm step
   * that provisions nothing. Kamino used to be the live example — mainnet
   * vaults catalogued into sandbox — and no longer is, since each environment
   * now catalogues its own cluster; the guard still stands for Ground and any
   * single-cluster provider, which is why this seeds clusters directly rather
   * than naming a provider.
   */
  it("drops a strategy the API says is not fundable in this environment", () => {
    const local = strategy({ id: "ground-devnet" });
    const elsewhere = strategy({
      id: "kamino-mainnet",
      provider: "kamino",
      hostCluster: "mainnet-beta",
      fundable: false,
    });

    expect(fundableStrategies([local, elsewhere]).map((s) => s.id)).toEqual(["ground-devnet"]);
  });

  it("keeps a routable, fundable strategy — the filter is opt-in, not opt-out", () => {
    const kept = strategy({ id: "keeper" });

    expect(fundableStrategies([kept])).toEqual([kept]);
  });

  /**
   * Version skew, and the reason this is `!== false` rather than a truthiness
   * check. The API is a separate deployable: a Vercel preview is a web-only
   * deploy pointed at the already-deployed API, and any rollout can put web
   * ahead of API. Both serve strategies with no `fundable` field at all.
   *
   * Reading that as "not fundable" blanks the whole catalogue — which is what
   * the first preview of this branch actually did. Admitting it is safe: an API
   * that omits the field has no mainnet-only provider registered, so it cannot
   * be serving a row this filter would need to hide.
   */
  it("keeps strategies from an API too old to send `fundable`", () => {
    // Built without the key rather than deleting it, so this really is the wire
    // shape an older API returns — the field never existed on that response.
    const { fundable: _omitted, ...fromOlderApi } = strategy({ id: "legacy" });

    expect(fundableStrategies([fromOlderApi as EarnStrategy]).map((s) => s.id)).toEqual(["legacy"]);
  });

  it("still hides an explicit fundable:false from a current API", () => {
    // The control: tolerating `undefined` must not tolerate a real `false`.
    const refused = strategy({ id: "mainnet-only", fundable: false });

    expect(fundableStrategies([refused])).toEqual([]);
  });
});

/**
 * The Opportunities tab's per-row verb. Greptile caught the gap these pin:
 * checking
 * only cluster + token let a PRODUCTION Kamino row render an enabled Deposit
 * link straight into `EarnDepositUnavailable`, because the route it points at
 * creates custodial programs only. Sandbox hid it — every Kamino row is
 * `wrong-cluster` there — so the third check has to be asserted, not eyeballed.
 */
describe("opportunityDepositability", () => {
  it("refuses a fundable vault-direct vault: SDP has no route for its deposit", () => {
    const kamino = strategy({
      id: "kamino-production",
      provider: "kamino",
      hostCluster: "mainnet-beta",
      // The exact shape that used to slip through: on-cluster and USDC.
      fundable: true,
    });

    expect(opportunityDepositability(kamino)).toEqual({
      kind: "no-sdp-route",
      style: "vault_direct",
    });
  });

  it("refuses a custodial vault while no custodial provider is offered", () => {
    // Ground is un-surfaced, so EARN_PROGRAM_CREATION_ENABLED is false and the
    // deposit route answers with its unavailable notice.
    expect(opportunityDepositability(strategy({ id: "ground-devnet" }))).toEqual({
      kind: "no-sdp-route",
      style: "custodial",
    });
  });

  it("reports the cluster before anything else — the most actionable answer", () => {
    const kamino = strategy({
      id: "kamino-sandbox",
      provider: "kamino",
      hostCluster: "mainnet-beta",
      fundable: false,
    });

    expect(opportunityDepositability(kamino)).toEqual({ kind: "wrong-cluster" });
  });

  it("reports an unroutable mint once the cluster is fine", () => {
    expect(
      opportunityDepositability(strategy({ id: "odd", depositMints: [UNROUTABLE_MINT] }))
    ).toEqual({
      kind: "asset-unsupported",
    });
  });
});

describe("strategyDepositEligibility", () => {
  it("keeps a mainnet-only Kamino row visible but reports the environment mismatch", () => {
    const kamino = strategy({
      id: "kamino-mainnet",
      provider: "kamino",
      hostCluster: "mainnet-beta",
      fundable: false,
    });

    expect(strategyDepositEligibility(kamino, "ground")).toBe("environment-mismatch");
    expect(rankedStrategies([kamino])).toEqual([kamino]);
  });

  it("keeps a catalogue-only provider ineligible even when its cluster matches", () => {
    const kamino = strategy({
      id: "kamino-production",
      provider: "kamino",
      hostCluster: "mainnet-beta",
      fundable: true,
    });

    expect(strategyDepositEligibility(kamino, "ground")).toBe("provider-unsupported");
  });

  it("accepts the pinned provider when its cluster and asset are supported", () => {
    expect(strategyDepositEligibility(strategy({ id: "ground-devnet" }), "ground")).toBe(
      "eligible"
    );
  });

  it("refuses an unsupported deposit asset without hiding its catalogue row", () => {
    const unknownAsset = strategy({ id: "unknown-asset", depositMints: [UNROUTABLE_MINT] });

    expect(strategyDepositEligibility(unknownAsset, "ground")).toBe("asset-unsupported");
    expect(rankedStrategies([unknownAsset])).toEqual([unknownAsset]);
  });
});

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
  it("returns routable stablecoins from both selectable and browse-only rows", () => {
    expect(
      availableTokens([
        strategy({ id: "a", depositMints: [USDC] }),
        strategy({ id: "b", depositMints: [USDT], fundable: false }),
        strategy({ id: "c", depositMints: [UNROUTABLE_MINT] }),
      ])
    ).toEqual(["usdc", "usdt"]);
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
