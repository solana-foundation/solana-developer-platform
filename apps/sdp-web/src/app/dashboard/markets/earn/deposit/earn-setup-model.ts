import type { EarnRiskTier, MockEarnStrategy } from "../earn-mock-data";

export type EarnDestination = "treasury" | "retail";
export type AssetPreference = "all" | "rwa" | "defi";

export type StrategyAllocation = Readonly<Record<string, number>>;

export interface EarnStrategyPreferences {
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
}

export interface CuratorProgram {
  id: string;
  strategies: readonly MockEarnStrategy[];
  /** Deposit mints accepted by at least one strategy in this curator's program. */
  depositMints: readonly string[];
}

export interface CuratorFundingPlan {
  curatorId: string;
  depositMint: string;
  strategies: readonly MockEarnStrategy[];
  strategyAllocation: StrategyAllocation;
}

/** Split 100 integer percentage points as evenly as possible in caller order. */
export function evenAllocation(ids: readonly string[]): Record<string, number> {
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) return {};

  const base = Math.floor(100 / uniqueIds.length);
  const remainder = 100 % uniqueIds.length;

  return Object.fromEntries(uniqueIds.map((id, index) => [id, base + (index < remainder ? 1 : 0)]));
}

export function allocationTotal(allocation: StrategyAllocation): number {
  return Object.values(allocation).reduce((total, percentage) => total + percentage, 0);
}

/**
 * Calculate the portfolio APY as a decimal (0.052 = 5.2%). Allocations are
 * portfolio percentages, so an incomplete allocation leaves the remainder at
 * zero yield rather than renormalizing it.
 */
export function weightedApy(
  strategies: readonly MockEarnStrategy[],
  allocation: StrategyAllocation
): number {
  return strategies.reduce((total, strategy) => {
    const percentage = allocation[strategy.id] ?? 0;
    const apy = Number(strategy.currentApy ?? 0);

    if (!Number.isFinite(percentage) || !Number.isFinite(apy)) return total;
    return total + apy * (percentage / 100);
  }, 0);
}

export function strategyMatchesPreferences(
  strategy: MockEarnStrategy,
  preferences: EarnStrategyPreferences
): boolean {
  const sourceMatches = preferences.source === "all" || strategy.sourceKind === preferences.source;
  const riskMatches = preferences.riskTier === null || strategy.riskTier === preferences.riskTier;
  return riskMatches && sourceMatches;
}

/** Whether a curator offers at least one strategy matching the user's preferences. */
export function curatorMatchesPreferences(
  curatorId: string,
  catalogue: readonly MockEarnStrategy[],
  preferences: EarnStrategyPreferences
): boolean {
  return catalogue.some(
    (strategy) =>
      strategy.curator === curatorId && strategyMatchesPreferences(strategy, preferences)
  );
}

/**
 * Deposit mints accepted by at least one strategy from a curator. This is a
 * union, not an intersection: the selected funding mint determines which
 * underlying strategies participate in the mock funding plan.
 */
export function curatorDepositMints(
  curatorId: string,
  catalogue: readonly MockEarnStrategy[]
): string[] {
  const seen = new Set<string>();
  const mints: string[] = [];

  for (const strategy of catalogue) {
    if (strategy.curator !== curatorId) continue;
    for (const mint of strategy.depositMints) {
      if (seen.has(mint)) continue;
      seen.add(mint);
      mints.push(mint);
    }
  }

  return mints;
}

/** Group strategies by curator in first catalogue appearance order. */
export function buildCuratorPrograms(catalogue: readonly MockEarnStrategy[]): CuratorProgram[] {
  const strategiesByCurator = new Map<string, MockEarnStrategy[]>();

  for (const strategy of catalogue) {
    const strategies = strategiesByCurator.get(strategy.curator);
    if (strategies) {
      strategies.push(strategy);
    } else {
      strategiesByCurator.set(strategy.curator, [strategy]);
    }
  }

  return [...strategiesByCurator].map(([id, strategies]) => ({
    id,
    strategies,
    depositMints: curatorDepositMints(id, catalogue),
  }));
}

/** Resolve the strategies a curator can fund with a specific deposit mint. */
export function strategiesForCuratorAndMint(
  curatorId: string,
  depositMint: string,
  catalogue: readonly MockEarnStrategy[]
): MockEarnStrategy[] {
  return catalogue.filter(
    (strategy) => strategy.curator === curatorId && strategy.depositMints.includes(depositMint)
  );
}

/**
 * Build the single-curator mock execution plan. Curator selection is the user
 * decision; underlying strategies receive a deterministic even initial split.
 */
export function buildCuratorFundingPlan(
  curatorId: string,
  depositMint: string,
  catalogue: readonly MockEarnStrategy[]
): CuratorFundingPlan {
  const strategies = strategiesForCuratorAndMint(curatorId, depositMint, catalogue);

  return {
    curatorId,
    depositMint,
    strategies,
    strategyAllocation: evenAllocation(strategies.map((strategy) => strategy.id)),
  };
}
