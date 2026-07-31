import { describe, expect, it } from "vitest";
import { MOCK_EARN_STRATEGIES, MOCK_EARN_WALLETS, type MockEarnStrategy } from "../earn-mock-data";
import {
  allocationTotal,
  canAddCompatibleStrategy,
  evenAllocation,
  isCommonDepositCompatible,
  selectedStrategies,
  selectionShape,
  strategyMatchesPreferences,
  weightedApy,
} from "./earn-setup-model";

function strategies(...ids: string[]): MockEarnStrategy[] {
  const resolved = selectedStrategies(ids, MOCK_EARN_STRATEGIES);
  if (resolved.length !== ids.length) {
    throw new Error(`Unknown strategy fixture in test: ${ids.join(", ")}`);
  }
  return resolved;
}

describe("selectedStrategies", () => {
  it("resolves strategies in caller order", () => {
    expect(
      selectedStrategies(
        ["earn_strategy_mock_kamino", "earn_strategy_mock_buidl"],
        MOCK_EARN_STRATEGIES
      ).map((strategy) => strategy.id)
    ).toEqual(["earn_strategy_mock_kamino", "earn_strategy_mock_buidl"]);
  });

  it("ignores unknown and repeated ids", () => {
    expect(
      selectedStrategies(
        ["missing", "earn_strategy_mock_buidl", "earn_strategy_mock_buidl"],
        MOCK_EARN_STRATEGIES
      ).map((strategy) => strategy.id)
    ).toEqual(["earn_strategy_mock_buidl"]);
  });

  it("returns an empty selection for empty inputs", () => {
    expect(selectedStrategies([], MOCK_EARN_STRATEGIES)).toEqual([]);
    expect(selectedStrategies(["earn_strategy_mock_buidl"], [])).toEqual([]);
  });
});

describe("selectionShape", () => {
  it("has no shape before a strategy is selected", () => {
    expect(selectionShape([])).toBeNull();
  });

  it("identifies a single strategy", () => {
    expect(selectionShape(strategies("earn_strategy_mock_buidl"))).toBe("single");
  });

  it("identifies multiple strategies from the same curator", () => {
    expect(selectionShape(strategies("earn_strategy_mock_buidl", "earn_strategy_mock_ousg"))).toBe(
      "same-curator"
    );
  });

  it("identifies a mixed-curator selection", () => {
    expect(selectionShape(strategies("earn_strategy_mock_buidl", "earn_strategy_mock_benji"))).toBe(
      "mixed-curators"
    );
  });
});

describe("evenAllocation", () => {
  it("returns no allocation when nothing is selected", () => {
    expect(evenAllocation([])).toEqual({});
  });

  it("allocates a single strategy at 100 percent", () => {
    expect(evenAllocation(["a"])).toEqual({ a: 100 });
  });

  it("distributes indivisible remainder points without losing the total", () => {
    const allocation = evenAllocation(["a", "b", "c", "d", "e", "f"]);

    expect(allocation).toEqual({ a: 17, b: 17, c: 17, d: 17, e: 16, f: 16 });
    expect(Object.values(allocation).every(Number.isInteger)).toBe(true);
    expect(allocationTotal(allocation)).toBe(100);
  });

  it("treats repeated strategy ids as one selection", () => {
    expect(evenAllocation(["a", "a", "b"])).toEqual({ a: 50, b: 50 });
  });
});

describe("allocationTotal", () => {
  it("totals empty, integer, and fractional allocations", () => {
    expect(allocationTotal({})).toBe(0);
    expect(allocationTotal({ a: 34, b: 33, c: 33 })).toBe(100);
    expect(allocationTotal({ a: 12.5, b: 37.5 })).toBe(50);
  });
});

describe("weightedApy", () => {
  const [buidl, kamino] = strategies("earn_strategy_mock_buidl", "earn_strategy_mock_kamino");

  it("weights decimal APYs by portfolio percentage", () => {
    expect(
      weightedApy([buidl, kamino], {
        [buidl.id]: 25,
        [kamino.id]: 75,
      })
    ).toBeCloseTo(0.058);
  });

  it("does not renormalize an incomplete allocation", () => {
    expect(weightedApy([buidl], { [buidl.id]: 50 })).toBeCloseTo(0.023);
  });

  it("ignores allocations without a selected strategy", () => {
    expect(weightedApy([buidl], { [buidl.id]: 100, missing: 100 })).toBeCloseTo(0.046);
  });

  it("treats missing or malformed APY observations as zero", () => {
    expect(
      weightedApy(
        [
          { ...buidl, id: "missing_apy", currentApy: undefined },
          { ...kamino, id: "invalid_apy", currentApy: "not-a-rate" },
        ],
        { missing_apy: 50, invalid_apy: 50 }
      )
    ).toBe(0);
  });

  it("returns zero for an empty selection", () => {
    expect(weightedApy([], { anything: 100 })).toBe(0);
  });
});

describe("strategyMatchesPreferences", () => {
  const [buidl, kamino] = strategies("earn_strategy_mock_buidl", "earn_strategy_mock_kamino");

  it("matches both risk and a specific source", () => {
    expect(
      strategyMatchesPreferences(buidl, {
        riskTier: "conservative",
        source: "rwa",
      })
    ).toBe(true);
  });

  it("uses all as a source wildcard", () => {
    expect(
      strategyMatchesPreferences(kamino, {
        riskTier: "balanced",
        source: "all",
      })
    ).toBe(true);
  });

  it("uses a missing risk choice as a risk wildcard", () => {
    expect(
      strategyMatchesPreferences(kamino, {
        riskTier: null,
        source: "defi",
      })
    ).toBe(true);
  });

  it("rejects either a risk or source mismatch", () => {
    expect(
      strategyMatchesPreferences(buidl, {
        riskTier: "enhanced",
        source: "rwa",
      })
    ).toBe(false);
    expect(
      strategyMatchesPreferences(buidl, {
        riskTier: "conservative",
        source: "defi",
      })
    ).toBe(false);
  });
});

describe("common deposit compatibility", () => {
  const [buidl, benji, ousg, sweep] = strategies(
    "earn_strategy_mock_buidl",
    "earn_strategy_mock_benji",
    "earn_strategy_mock_ousg",
    "earn_strategy_mock_sweep"
  );

  it("allows a candidate that retains at least one common mint", () => {
    expect(isCommonDepositCompatible([benji, ousg], buidl)).toBe(true);
    expect(canAddCompatibleStrategy([benji.id, ousg.id], buidl.id, MOCK_EARN_STRATEGIES)).toBe(
      true
    );
  });

  it("rejects a candidate that empties the common-mint intersection", () => {
    expect(isCommonDepositCompatible([buidl], sweep)).toBe(false);
    expect(canAddCompatibleStrategy([buidl.id], sweep.id, MOCK_EARN_STRATEGIES)).toBe(false);
  });

  it("allows a first candidate only when it accepts a deposit mint", () => {
    expect(isCommonDepositCompatible([], buidl)).toBe(true);
    expect(isCommonDepositCompatible([], { ...buidl, depositMints: [] })).toBe(false);
  });

  it("handles an already-selected candidate without duplicating it", () => {
    expect(canAddCompatibleStrategy([buidl.id], buidl.id, MOCK_EARN_STRATEGIES)).toBe(true);
  });

  it("rejects an unknown candidate id", () => {
    expect(canAddCompatibleStrategy([buidl.id], "missing", MOCK_EARN_STRATEGIES)).toBe(false);
  });
});

describe("mock funding paths", () => {
  it("keeps every catalogue strategy fundable from every selectable wallet", () => {
    for (const wallet of MOCK_EARN_WALLETS) {
      for (const strategy of MOCK_EARN_STRATEGIES) {
        expect(
          strategy.depositMints.some((mint) => (wallet.balances[mint] ?? 0) > 0),
          `${wallet.name} cannot fund ${strategy.name}`
        ).toBe(true);
      }
    }
  });
});
