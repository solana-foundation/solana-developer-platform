import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  availableTokens,
  browsableStrategies,
  fundableStrategies,
  isStrategySelectable,
  rankedBrowsableStrategies,
  singleStrategyAllocation,
  strategyUnavailability,
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

describe("strategyUnavailability", () => {
  it("clears a Ground row that exists on this cluster", () => {
    expect(strategyUnavailability(strategy({ id: "ok" }))).toBeUndefined();
  });

  it("marks a provider with no program support browse-only", () => {
    const kamino = strategy({ id: "k", provider: "kamino" });

    expect(strategyUnavailability(kamino)).toBe("no_program_support");
  });

  /**
   * Precedence, and it is deliberate. A Kamino row in sandbox is BOTH
   * off-cluster and unsupported; "Mainnet only" tells the reader something they
   * can act on, while "Browse only" reads as permanent and is what production
   * should show for the same vault.
   */
  it("reports the cluster reason first when both apply", () => {
    const kaminoInSandbox = strategy({ id: "k", provider: "kamino", fundable: false });

    expect(strategyUnavailability(kaminoInSandbox)).toBe("not_on_this_cluster");
  });

  it("marks a supported provider off-cluster too", () => {
    const groundElsewhere = strategy({ id: "g", fundable: false });

    expect(strategyUnavailability(groundElsewhere)).toBe("not_on_this_cluster");
  });

  it("treats an absent fundable as no cluster objection (version skew)", () => {
    const { fundable: _omitted, ...fromOlderApi } = strategy({ id: "legacy" });

    expect(strategyUnavailability(fromOlderApi as EarnStrategy)).toBeUndefined();
  });

  /**
   * The wizard guards its selection with `isStrategySelectable` while the table
   * renders the chip from `strategyUnavailability`. They must never disagree, or
   * a row could show "Browse only" and still reach review via a stale
   * `?strategy=<id>` deep link.
   */
  it("agrees with isStrategySelectable, which is what guards the wizard", () => {
    for (const row of [
      strategy({ id: "ok" }),
      strategy({ id: "k", provider: "kamino" }),
      strategy({ id: "g", fundable: false }),
    ]) {
      expect(isStrategySelectable(row)).toBe(strategyUnavailability(row) === undefined);
    }
  });
});

describe("browsableStrategies", () => {
  /**
   * The catalogue and the fundable set are different sets, and that difference
   * is the point: SDP serves the communal vaults, so the table shows what
   * exists. Dropping these rows is what made the Kamino shelf invisible.
   */
  it("keeps providers the flow cannot start a program with", () => {
    const ground = strategy({ id: "ground-row" });
    const kamino = strategy({ id: "kamino-row", provider: "kamino", fundable: false });

    expect(browsableStrategies([ground, kamino]).map((s) => s.id)).toEqual([
      "ground-row",
      "kamino-row",
    ]);
  });

  it("still drops a row with no routable token lane — nothing to render", () => {
    const noLane = strategy({ id: "sol", depositMints: [UNROUTABLE_MINT] });

    expect(browsableStrategies([noLane])).toEqual([]);
  });
});

describe("fundableStrategies", () => {
  it("drops a strategy whose deposit mint is not a routable stablecoin", () => {
    const kept = strategy({ id: "usdc" });
    const dropped = strategy({ id: "sol", depositMints: [UNROUTABLE_MINT] });

    expect(fundableStrategies([kept, dropped]).map((s) => s.id)).toEqual(["usdc"]);
  });

  /**
   * The devnet-money guard, dashboard side. Kamino's mainnet-only vaults are
   * catalogued into sandbox so integrators can browse the real shelf; the API
   * marks them `fundable: false` and the wizard must never offer one, or a user
   * walks to a confirm step that provisions nothing.
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

  /** Version skew — an API deployed behind this web build sends no `fundable`
   * at all; see the note on `strategyUnavailability`. */
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

describe("rankedBrowsableStrategies", () => {
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
    const visible = rankedBrowsableStrategies(catalogue);
    expect(visible.map((entry) => entry.id)).toEqual([
      "delayed-top",
      "instant-high",
      "instant-low",
      "no-rate",
    ]);
  });

  it("omits strategies whose deposit mint is not a routable stablecoin", () => {
    const visible = rankedBrowsableStrategies([
      strategy({ id: "unroutable", depositMints: [UNROUTABLE_MINT] }),
    ]);
    expect(visible).toHaveLength(0);
  });

  /**
   * The whole reason this is `Browsable` and not `Fundable`. A Kamino vault
   * carrying the best rate on the shelf must still appear, and appear FIRST —
   * ranking it below the rows SDP can fund would quietly editorialise the
   * comparison table. `strategy-step` marks it browse-only; the model does not
   * demote it.
   */
  it("ranks a browse-only vault on its real rate rather than dropping it", () => {
    const kamino = strategy({
      id: "kamino-top",
      provider: "kamino",
      currentApy: "0.15",
      fundable: false,
    });

    expect(rankedBrowsableStrategies([...catalogue, kamino]).map((entry) => entry.id)).toEqual([
      "kamino-top",
      "delayed-top",
      "instant-high",
      "instant-low",
      "no-rate",
    ]);
  });

  it("does not mutate the input array", () => {
    const input = [instantLow, instantHigh];
    rankedBrowsableStrategies(input);
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
