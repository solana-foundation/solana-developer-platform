import type {
  EarnPortfolioAllocationInput,
  EarnPortfolioToken,
  EarnStrategy,
  EarnStrategySourceKind,
} from "@sdp/types";
import {
  settlementDays,
  strategyApy,
  strategyPoolUsd,
  strategyToken,
} from "../earn-program-presentation";

/**
 * Pure model for the Earn deposit flow: full catalogue → direct filters → ONE
 * strategy → a 100% allocation.
 *
 * Every value is derived from a field the provider actually reports. For Ground
 * (the only live provider) the catalogue row is mapped from
 * `GET /v2/wallets/yield-sources` by `@sdp/earn`:
 *
 * | Ground field                | Catalogue field                       |
 * |-----------------------------|---------------------------------------|
 * | `apyBps`                    | `currentApy` (decimal string)          |
 * | `depositToken` → mint       | `depositMints`                         |
 * | `allocations[].type`        | `sourceKind` (`rwa` \| `defi`)         |
 * | `processingPolicies.redeem` | `liquidityTerm`/`redemptionDelayDays`  |
 * | `tvlUsd`                    | `riskMetadata.tvlUsd`                  |
 * | `protocol`                  | `underlyingSource`                     |
 *
 * Ground publishes **no** risk tier, rating, or grade on a yield source. The UI
 * therefore exposes the observable fields above directly instead of assigning
 * a strategy to a synthetic liquidity/yield category.
 */

/** How a filtered catalogue is ordered. */
export const EARN_STRATEGY_SORTS = ["apy", "size", "access"] as const;
export type EarnStrategySort = (typeof EARN_STRATEGY_SORTS)[number];

/** The short settlement ceiling offered by the browse step's access filter. */
export const EARN_SHORT_SETTLEMENT_DAYS = 3;

/**
 * Catalogue filters. `null` always means "no constraint" so an absent provider
 * field can never silently exclude a strategy.
 */
export interface EarnStrategyFilters {
  /** Longest acceptable redemption wait, in whole days. `0` = instant only. */
  maxSettlementDays: number | null;
  /** Restrict to one backing kind. */
  sourceKind: EarnStrategySourceKind | null;
  /** Restrict to one funding stablecoin. */
  token: EarnPortfolioToken | null;
  sort: EarnStrategySort;
}

/** Show the full fundable catalogue initially, ranked by indicative APY. */
export function defaultStrategyFilters(): EarnStrategyFilters {
  return { maxSettlementDays: null, sourceKind: null, token: null, sort: "apy" };
}

/** Strategies that can actually be funded — i.e. their deposit mint is routable. */
export function fundableStrategies(strategies: readonly EarnStrategy[]): readonly EarnStrategy[] {
  return strategies.filter((strategy) => strategyToken(strategy) !== undefined);
}

/** Apply only the direct controls shown above the strategy table. */
export function matchesFilters(strategy: EarnStrategy, filters: EarnStrategyFilters): boolean {
  if (filters.maxSettlementDays !== null && settlementDays(strategy) > filters.maxSettlementDays) {
    return false;
  }
  if (filters.sourceKind !== null && strategy.sourceKind !== filters.sourceKind) return false;
  if (filters.token !== null && strategyToken(strategy) !== filters.token) return false;
  return true;
}

function descendingUnknownLast(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

function compareByApy(left: EarnStrategy, right: EarnStrategy): number {
  return descendingUnknownLast(strategyApy(left), strategyApy(right));
}

/** Sort comparators. Rows missing the sorted-on value always fall to the end. */
const COMPARATORS: Record<EarnStrategySort, (a: EarnStrategy, b: EarnStrategy) => number> = {
  apy: compareByApy,
  size: (left, right) => descendingUnknownLast(strategyPoolUsd(left), strategyPoolUsd(right)),
  access: (left, right) =>
    settlementDays(left) - settlementDays(right) || compareByApy(left, right),
};

/** The browse step's list: fundable, filtered, sorted. Never mutates the input. */
export function visibleStrategies(
  strategies: readonly EarnStrategy[],
  filters: EarnStrategyFilters
): readonly EarnStrategy[] {
  const matching = fundableStrategies(strategies).filter((strategy) =>
    matchesFilters(strategy, filters)
  );
  return [...matching].sort(COMPARATORS[filters.sort]);
}

/** The stablecoins the catalogue can actually fund, for the token filter chips. */
export function availableTokens(
  strategies: readonly EarnStrategy[]
): readonly EarnPortfolioToken[] {
  const tokens = new Set<EarnPortfolioToken>();
  for (const strategy of fundableStrategies(strategies)) {
    const token = strategyToken(strategy);
    if (token) tokens.add(token);
  }
  return [...tokens];
}

/**
 * The program request for a single chosen strategy: 100% of that strategy's
 * stablecoin group. This is the only shape the V1 API accepts — it caps each
 * token group at exactly one entry (PRO-1667), and the sum rule pins it to
 * 100. Omitted groups keep their current allocation, so picking a USDC
 * strategy never disturbs an existing USDT strategy.
 */
export function singleStrategyAllocation(
  strategy: EarnStrategy
): EarnPortfolioAllocationInput | undefined {
  const token = strategyToken(strategy);
  if (!token) return undefined;
  return { [token]: [{ yieldSourceId: strategy.providerReference, pct: 100 }] };
}
