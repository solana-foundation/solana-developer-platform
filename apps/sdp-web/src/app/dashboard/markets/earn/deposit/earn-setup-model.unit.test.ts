import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEPOSIT_MINT,
  MOCK_EARN_STRATEGIES,
  MOCK_EARN_WALLETS,
  type MockEarnStrategy,
  tokenSymbol,
} from "../earn-mock-data";
import {
  allocationTotal,
  buildCuratorFundingPlan,
  buildCuratorPrograms,
  curatorDepositMints,
  curatorMatchesPreferences,
  evenAllocation,
  strategiesForCuratorAndMint,
  strategyMatchesPreferences,
  weightedApy,
} from "./earn-setup-model";

function strategy(id: string): MockEarnStrategy {
  const resolved = MOCK_EARN_STRATEGIES.find((candidate) => candidate.id === id);
  if (!resolved) throw new Error(`Unknown strategy fixture in test: ${id}`);
  return resolved;
}

describe("evenAllocation", () => {
  it("returns no allocation when nothing is selected", () => {
    expect(evenAllocation([])).toEqual({});
  });

  it("allocates one underlying strategy at 100 percent", () => {
    expect(evenAllocation(["a"])).toEqual({ a: 100 });
  });

  it("distributes indivisible remainder points without losing the total", () => {
    const allocation = evenAllocation(["a", "b", "c", "d", "e", "f"]);

    expect(allocation).toEqual({ a: 17, b: 17, c: 17, d: 17, e: 16, f: 16 });
    expect(Object.values(allocation).every(Number.isInteger)).toBe(true);
    expect(allocationTotal(allocation)).toBe(100);
  });

  it("treats repeated ids as one allocation target", () => {
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
  const buidl = strategy("earn_strategy_mock_buidl");
  const kamino = strategy("earn_strategy_mock_kamino");

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

describe("strategy and curator preference matching", () => {
  const buidl = strategy("earn_strategy_mock_buidl");
  const kamino = strategy("earn_strategy_mock_kamino");

  it("matches a strategy against both risk and source preferences", () => {
    expect(
      strategyMatchesPreferences(buidl, {
        riskTier: "conservative",
        source: "rwa",
      })
    ).toBe(true);
    expect(
      strategyMatchesPreferences(buidl, {
        riskTier: "enhanced",
        source: "rwa",
      })
    ).toBe(false);
  });

  it("uses all sources and a missing risk choice as wildcards", () => {
    expect(strategyMatchesPreferences(kamino, { riskTier: "balanced", source: "all" })).toBe(true);
    expect(strategyMatchesPreferences(kamino, { riskTier: null, source: "defi" })).toBe(true);
  });

  it("matches a curator when any of its strategies fit", () => {
    expect(
      curatorMatchesPreferences("steakhouse", MOCK_EARN_STRATEGIES, {
        riskTier: "conservative",
        source: "rwa",
      })
    ).toBe(true);
    expect(
      curatorMatchesPreferences("sentora", MOCK_EARN_STRATEGIES, {
        riskTier: "enhanced",
        source: "rwa",
      })
    ).toBe(true);
  });

  it("rejects a curator with no matching offering, including unknown ids", () => {
    expect(
      curatorMatchesPreferences("steakhouse", MOCK_EARN_STRATEGIES, {
        riskTier: "balanced",
        source: "defi",
      })
    ).toBe(false);
    expect(
      curatorMatchesPreferences("unknown-curator", MOCK_EARN_STRATEGIES, {
        riskTier: null,
        source: "all",
      })
    ).toBe(false);
  });
});

describe("curator programs", () => {
  it("groups the catalogue in first curator appearance order", () => {
    const programs = buildCuratorPrograms(MOCK_EARN_STRATEGIES);

    expect(programs.map((program) => program.id)).toEqual(["steakhouse", "gauntlet", "sentora"]);
    expect(programs.map((program) => program.strategies.length)).toEqual([3, 4, 2]);
  });

  it("uses a mint union within each curator program", () => {
    expect(curatorDepositMints("steakhouse", MOCK_EARN_STRATEGIES).map(tokenSymbol)).toEqual([
      "USDC",
      "USDG",
      "PYUSD",
    ]);
    expect(curatorDepositMints("gauntlet", MOCK_EARN_STRATEGIES).map(tokenSymbol)).toEqual([
      "USDC",
      "USDG",
    ]);
    expect(curatorDepositMints("sentora", MOCK_EARN_STRATEGIES).map(tokenSymbol)).toEqual([
      "USDC",
      "USDT",
    ]);
  });

  it("keeps an open-registry curator found in catalogue data", () => {
    const custom = {
      ...strategy("earn_strategy_mock_buidl"),
      id: "earn_strategy_mock_custom",
      curator: "unknown-curator",
    };

    expect(buildCuratorPrograms([custom])).toEqual([
      {
        id: "unknown-curator",
        strategies: [custom],
        depositMints: custom.depositMints,
      },
    ]);
  });

  it("returns empty fallbacks for an unknown curator or catalogue", () => {
    expect(curatorDepositMints("unknown-curator", MOCK_EARN_STRATEGIES)).toEqual([]);
    expect(buildCuratorPrograms([])).toEqual([]);
  });
});

describe("single-curator funding plan", () => {
  const sweep = strategy("earn_strategy_mock_sweep");
  const pyusd = sweep.depositMints[0];

  it("routes Steakhouse USDC into only its USDC-compatible strategies", () => {
    const plan = buildCuratorFundingPlan("steakhouse", DEFAULT_DEPOSIT_MINT, MOCK_EARN_STRATEGIES);

    expect(plan.strategies.map((candidate) => candidate.id)).toEqual([
      "earn_strategy_mock_buidl",
      "earn_strategy_mock_ousg",
    ]);
    expect(plan.strategyAllocation).toEqual({
      earn_strategy_mock_buidl: 50,
      earn_strategy_mock_ousg: 50,
    });
    expect(allocationTotal(plan.strategyAllocation)).toBe(100);
    expect(weightedApy(plan.strategies, plan.strategyAllocation)).toBeCloseTo(0.0485);
  });

  it("routes Steakhouse PYUSD exclusively into its sweep strategy", () => {
    const plan = buildCuratorFundingPlan("steakhouse", pyusd, MOCK_EARN_STRATEGIES);

    expect(plan.strategies.map((candidate) => candidate.id)).toEqual([sweep.id]);
    expect(plan.strategyAllocation).toEqual({ [sweep.id]: 100 });
  });

  it("keeps derived allocation totals exact when a curator has three legs", () => {
    const buidl = strategy("earn_strategy_mock_buidl");
    const ousg = strategy("earn_strategy_mock_ousg");
    const catalogue = [{ ...buidl }, { ...ousg }, { ...buidl, id: "third" }];
    const plan = buildCuratorFundingPlan("steakhouse", DEFAULT_DEPOSIT_MINT, catalogue);

    expect(plan.strategyAllocation).toEqual({
      [buidl.id]: 34,
      [ousg.id]: 33,
      third: 33,
    });
    expect(allocationTotal(plan.strategyAllocation)).toBe(100);
  });

  it("returns a stable empty plan for an unknown curator or unsupported mint", () => {
    expect(
      buildCuratorFundingPlan("unknown-curator", DEFAULT_DEPOSIT_MINT, MOCK_EARN_STRATEGIES)
    ).toEqual({
      curatorId: "unknown-curator",
      depositMint: DEFAULT_DEPOSIT_MINT,
      strategies: [],
      strategyAllocation: {},
    });
    expect(strategiesForCuratorAndMint("steakhouse", "unsupported", MOCK_EARN_STRATEGIES)).toEqual(
      []
    );
  });

  it("builds a non-empty exact plan for every advertised curator mint", () => {
    for (const program of buildCuratorPrograms(MOCK_EARN_STRATEGIES)) {
      for (const mint of program.depositMints) {
        const plan = buildCuratorFundingPlan(program.id, mint, MOCK_EARN_STRATEGIES);
        expect(
          plan.strategies.length,
          `${program.id} cannot route ${tokenSymbol(mint)}`
        ).toBeGreaterThan(0);
        expect(plan.strategies.every((candidate) => candidate.depositMints.includes(mint))).toBe(
          true
        );
        expect(allocationTotal(plan.strategyAllocation)).toBe(100);
      }
    }
  });
});

describe("mock wallet funding paths", () => {
  it("keeps every curator fundable from every selectable wallet", () => {
    for (const wallet of MOCK_EARN_WALLETS) {
      for (const program of buildCuratorPrograms(MOCK_EARN_STRATEGIES)) {
        expect(
          program.depositMints.some((mint) => (wallet.balances[mint] ?? 0) > 0),
          `${wallet.name} cannot fund ${program.id}`
        ).toBe(true);
      }
    }
  });
});
