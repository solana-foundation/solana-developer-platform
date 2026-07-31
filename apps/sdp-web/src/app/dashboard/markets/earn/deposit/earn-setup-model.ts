import { commonDepositMints, type EarnRiskTier, type MockEarnStrategy } from "../earn-mock-data";

export type EarnDestination = "treasury" | "retail";
export type AssetPreference = "all" | "rwa" | "defi";
export type AllocationMode = "delegate" | "custom";
export type SelectionShape = "single" | "same-curator" | "mixed-curators";

export type StrategyAllocation = Readonly<Record<string, number>>;

export interface EarnStrategyPreferences {
  riskTier: EarnRiskTier | null;
  source: AssetPreference;
}

/** Resolve a selection in caller order, ignoring unknown and repeated ids. */
export function selectedStrategies(
  ids: readonly string[],
  catalogue: readonly MockEarnStrategy[]
): MockEarnStrategy[] {
  const strategiesById = new Map(catalogue.map((strategy) => [strategy.id, strategy]));
  const seen = new Set<string>();

  return ids.flatMap((id) => {
    const strategy = strategiesById.get(id);
    if (!strategy || seen.has(id)) return [];

    seen.add(id);
    return [strategy];
  });
}

/** There is no selection shape until at least one strategy is selected. */
export function selectionShape(strategies: readonly MockEarnStrategy[]): SelectionShape | null {
  if (strategies.length === 0) return null;
  if (strategies.length === 1) return "single";

  const curator = strategies[0].curator;
  return strategies.every((strategy) => strategy.curator === curator)
    ? "same-curator"
    : "mixed-curators";
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

/**
 * A candidate can join the selection only when every resulting strategy can
 * accept at least one common deposit mint.
 */
export function isCommonDepositCompatible(
  selected: readonly MockEarnStrategy[],
  candidate: MockEarnStrategy
): boolean {
  return commonDepositMints([...selected, candidate]).length > 0;
}

/** Id-based convenience helper for strategy-picking UI. */
export function canAddCompatibleStrategy(
  selectedIds: readonly string[],
  candidateId: string,
  catalogue: readonly MockEarnStrategy[]
): boolean {
  const candidate = catalogue.find((strategy) => strategy.id === candidateId);
  if (!candidate) return false;

  const selected = selectedStrategies(
    selectedIds.filter((id) => id !== candidateId),
    catalogue
  );
  return isCommonDepositCompatible(selected, candidate);
}
