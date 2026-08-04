import type { EarnStrategy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { buildCuratorPrograms } from "../earn-program-presentation";
import {
  buildAllocationInput,
  curatorTokenGroups,
  defaultWeightInputs,
  evenAllocation,
  parseAllocation,
  portfolioTokenForMint,
  weightedApy,
} from "./earn-setup-model";

const TIMESTAMP = "2026-07-18T09:00:00.000Z";
// Canonical Solana mints (mainnet unless noted) from @sdp/types well-known tokens.
const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const USDT_MAINNET = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const PYUSD_MAINNET = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

function strategy(partial: {
  id: string;
  providerReference: string;
  curator?: string;
  currentApy?: string;
  depositMints?: string[];
}): EarnStrategy {
  return {
    id: partial.id,
    provider: "ground",
    providerReference: partial.providerReference,
    name: partial.id,
    sourceKind: "defi",
    depositMints: partial.depositMints ?? [USDC_MAINNET],
    apyType: "variable",
    currentApy: partial.currentApy ?? "0.05",
    liquidityTerm: "instant",
    riskMetadata: partial.curator ? { curator: partial.curator } : undefined,
    status: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

const GAUNTLET_USDC = strategy({
  id: "earn_strategy_gauntlet_usdc",
  providerReference: "morpho-gauntlet-usdc",
  curator: "gauntlet",
  currentApy: "0.062",
});
const GAUNTLET_USDT = strategy({
  id: "earn_strategy_gauntlet_usdt",
  providerReference: "morpho-gauntlet-usdt",
  curator: "gauntlet",
  currentApy: "0.048",
  depositMints: [USDT_MAINNET],
});
const STEAKHOUSE_USDC = strategy({
  id: "earn_strategy_steakhouse_usdc",
  providerReference: "morpho-steakhouse-usdc",
  curator: "steakhouse",
  currentApy: "0.045",
});

describe("portfolioTokenForMint", () => {
  it("maps canonical USDC mints on both clusters", () => {
    expect(portfolioTokenForMint(USDC_MAINNET)).toBe("usdc");
    expect(portfolioTokenForMint(USDC_DEVNET)).toBe("usdc");
  });

  it("maps the canonical USDT mint", () => {
    expect(portfolioTokenForMint(USDT_MAINNET)).toBe("usdt");
  });

  it("returns undefined for stablecoins outside the portfolio rail and unknown mints", () => {
    expect(portfolioTokenForMint(PYUSD_MAINNET)).toBeUndefined();
    expect(portfolioTokenForMint("not-a-mint")).toBeUndefined();
  });
});

describe("curatorTokenGroups", () => {
  it("groups a curator's strategies by fundable portfolio token in registry order", () => {
    const groups = curatorTokenGroups([GAUNTLET_USDT, GAUNTLET_USDC]);

    expect(groups.map((group) => group.token)).toEqual(["usdc", "usdt"]);
    expect(groups[0].strategies).toEqual([GAUNTLET_USDC]);
    expect(groups[1].strategies).toEqual([GAUNTLET_USDT]);
  });

  it("places a dual-mint strategy in both token groups", () => {
    const dual = strategy({
      id: "earn_strategy_dual",
      providerReference: "dual",
      depositMints: [USDC_MAINNET, USDT_MAINNET],
    });

    const groups = curatorTokenGroups([dual]);
    expect(groups.map((group) => group.token)).toEqual(["usdc", "usdt"]);
    expect(groups.every((group) => group.strategies.includes(dual))).toBe(true);
  });

  it("omits token groups with no eligible strategy and handles empty programs", () => {
    expect(curatorTokenGroups([GAUNTLET_USDC]).map((group) => group.token)).toEqual(["usdc"]);
    expect(curatorTokenGroups([])).toEqual([]);
  });
});

describe("evenAllocation", () => {
  it("returns no allocation when nothing is selected", () => {
    expect(evenAllocation([])).toEqual({});
  });

  it("allocates one strategy at 100 percent", () => {
    expect(evenAllocation(["a"])).toEqual({ a: 100 });
  });

  it("distributes indivisible remainder tenths without losing the total", () => {
    expect(evenAllocation(["a", "b", "c"])).toEqual({ a: 33.4, b: 33.3, c: 33.3 });

    const six = evenAllocation(["a", "b", "c", "d", "e", "f"]);
    expect(six).toEqual({ a: 16.7, b: 16.7, c: 16.7, d: 16.7, e: 16.6, f: 16.6 });
    expect(
      parseAllocation(Object.fromEntries(Object.entries(six).map(([id, pct]) => [id, String(pct)])))
        .issue
    ).toBeUndefined();
  });

  it("treats repeated ids as one allocation target", () => {
    expect(evenAllocation(["a", "a", "b"])).toEqual({ a: 50, b: 50 });
  });
});

describe("defaultWeightInputs", () => {
  it("produces string inputs per token group that already validate", () => {
    const groups = curatorTokenGroups([GAUNTLET_USDC, GAUNTLET_USDT]);
    const defaults = defaultWeightInputs(groups);

    expect(defaults.usdc).toEqual({ [GAUNTLET_USDC.id]: "100" });
    expect(defaults.usdt).toEqual({ [GAUNTLET_USDT.id]: "100" });
    expect(parseAllocation(defaults.usdc ?? {}).issue).toBeUndefined();
  });
});

describe("parseAllocation", () => {
  it("accepts weights on the 0.1 grid summing to exactly 100", () => {
    const parsed = parseAllocation({ a: "33.4", b: "33.3", c: "33.3" });

    expect(parsed.issue).toBeUndefined();
    expect(parsed.weights).toEqual({ a: 33.4, b: 33.3, c: 33.3 });
    expect(parsed.totalPct).toBe(100);
  });

  it("treats blanks as zero and drops zero weights from the payload set", () => {
    const parsed = parseAllocation({ a: "100", b: "", c: "0" });

    expect(parsed.issue).toBeUndefined();
    expect(parsed.weights).toEqual({ a: 100 });
  });

  it("flags off-grid, negative, out-of-range, and non-numeric weights as malformed", () => {
    expect(parseAllocation({ a: "33.45", b: "66.55" }).issue).toBe("malformed");
    expect(parseAllocation({ a: "-1", b: "101" }).issue).toBe("malformed");
    expect(parseAllocation({ a: "abc", b: "100" }).issue).toBe("malformed");
  });

  it("flags a grid-valid sum that is not exactly 100", () => {
    const under = parseAllocation({ a: "50", b: "49.9" });
    expect(under.issue).toBe("sum");
    expect(under.totalPct).toBe(99.9);

    const empty = parseAllocation({});
    expect(empty.issue).toBe("sum");
    expect(empty.totalPct).toBe(0);
  });

  it("stays exact where floating-point accumulation would drift", () => {
    // 0.1-heavy splits like 30.1 + 69.9 famously fail with naive float sums.
    expect(parseAllocation({ a: "30.1", b: "69.9" }).issue).toBeUndefined();
  });
});

describe("weightedApy", () => {
  it("weights decimal APYs by portfolio percentage", () => {
    expect(
      weightedApy([GAUNTLET_USDC, STEAKHOUSE_USDC], {
        [GAUNTLET_USDC.id]: 25,
        [STEAKHOUSE_USDC.id]: 75,
      })
    ).toBeCloseTo(0.04925);
  });

  it("does not renormalize an incomplete allocation", () => {
    expect(weightedApy([GAUNTLET_USDC], { [GAUNTLET_USDC.id]: 50 })).toBeCloseTo(0.031);
  });

  it("ignores weights without a matching strategy", () => {
    expect(weightedApy([GAUNTLET_USDC], { [GAUNTLET_USDC.id]: 100, missing: 100 })).toBeCloseTo(
      0.062
    );
  });

  it("treats missing or malformed APY observations as zero", () => {
    expect(
      weightedApy(
        [
          { ...GAUNTLET_USDC, id: "missing_apy", currentApy: undefined },
          { ...GAUNTLET_USDC, id: "invalid_apy", currentApy: "not-a-rate" },
        ],
        { missing_apy: 50, invalid_apy: 50 }
      )
    ).toBe(0);
  });

  it("returns zero for an empty selection", () => {
    expect(weightedApy([], { anything: 100 })).toBe(0);
  });
});

describe("buildAllocationInput", () => {
  it("keys weights to provider yield-source ids per token group", () => {
    const groups = curatorTokenGroups([GAUNTLET_USDC, GAUNTLET_USDT]);

    expect(
      buildAllocationInput(groups, {
        usdc: { [GAUNTLET_USDC.id]: 100 },
        usdt: { [GAUNTLET_USDT.id]: 100 },
      })
    ).toEqual({
      usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", pct: 100 }],
      usdt: [{ yieldSourceId: "morpho-gauntlet-usdt", pct: 100 }],
    });
  });

  it("omits zero weights and token groups without any positive weight", () => {
    const groups = curatorTokenGroups([GAUNTLET_USDC, STEAKHOUSE_USDC, GAUNTLET_USDT]);

    expect(
      buildAllocationInput(groups, {
        usdc: { [GAUNTLET_USDC.id]: 100, [STEAKHOUSE_USDC.id]: 0 },
        usdt: {},
      })
    ).toEqual({
      usdc: [{ yieldSourceId: "morpho-gauntlet-usdc", pct: 100 }],
    });
  });
});

describe("curator grouping from live rows", () => {
  it("keeps first-appearance order and every strategy fundable via a token group", () => {
    const programs = buildCuratorPrograms([STEAKHOUSE_USDC, GAUNTLET_USDC, GAUNTLET_USDT]);

    expect(programs.map((program) => program.id)).toEqual(["steakhouse", "gauntlet"]);
    for (const program of programs) {
      const grouped = curatorTokenGroups(program.strategies).flatMap((group) => group.strategies);
      expect(new Set(grouped)).toEqual(new Set(program.strategies));
    }
  });
});
