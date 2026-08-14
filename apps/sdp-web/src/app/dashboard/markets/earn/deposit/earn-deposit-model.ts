import type { EarnPortfolioAllocationInput, EarnPortfolioToken, EarnStrategy } from "@sdp/types";
import { strategyApy, strategyPoolUsd, strategyToken } from "../earn-program-presentation";

/**
 * Pure model for the Earn deposit flow: full catalogue → ranked fundable rows
 * (APY by default, or whichever column the reader ranked by) → ONE strategy →
 * a 100% allocation.
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

/** Strategies that can actually be funded — i.e. their deposit mint is routable. */
export function fundableStrategies(strategies: readonly EarnStrategy[]): readonly EarnStrategy[] {
  return strategies.filter((strategy) => strategyToken(strategy) !== undefined);
}

/** The reported columns a reader may rank the comparison table by. */
export type EarnStrategySortColumn = "apy" | "pool";

export interface EarnStrategySort {
  column: EarnStrategySortColumn;
  direction: "asc" | "desc";
}

/** Highest indicative APY first — the order the comparison table opens in. */
export const DEFAULT_STRATEGY_SORT: EarnStrategySort = { column: "apy", direction: "desc" };

/** The reported figure behind each sortable column; `undefined` = unreported. */
const SORT_VALUES: Record<EarnStrategySortColumn, (strategy: EarnStrategy) => number | undefined> =
  {
    apy: strategyApy,
    pool: strategyPoolUsd,
  };

/**
 * Rank the catalogue by one reported column. The ONE comparator in this module —
 * the default order below is this function, so re-ranking an already-ranked list
 * with {@link DEFAULT_STRATEGY_SORT} is a no-op rather than a second opinion.
 *
 * Two rules hold in BOTH directions:
 * - **Unreported sorts last.** A strategy with no pool size or no rate renders
 *   "—", and floating those to the top of an ascending pass would rank the rows
 *   we know least about above every row the reader can actually compare.
 * - **Ties break on name.** The catalogue arrives in provider order and is
 *   re-read on revalidation, so two strategies reporting the same figure (5.1%
 *   and 5.1%) would otherwise be free to swap places under the reader's cursor.
 */
export function sortStrategies(
  strategies: readonly EarnStrategy[],
  sort: EarnStrategySort
): readonly EarnStrategy[] {
  const reportedValue = SORT_VALUES[sort.column];
  return [...strategies].sort((left, right) => {
    const leftValue = reportedValue(left);
    const rightValue = reportedValue(right);
    if (leftValue === undefined || rightValue === undefined) {
      if (leftValue === rightValue) return left.name.localeCompare(right.name);
      return leftValue === undefined ? 1 : -1;
    }
    if (leftValue !== rightValue) {
      return sort.direction === "asc" ? leftValue - rightValue : rightValue - leftValue;
    }
    return left.name.localeCompare(right.name);
  });
}

/**
 * What clicking a column header does: the active column flips direction, and a
 * newly clicked column opens descending — for both pool size and APY the end
 * worth landing on first is the large one.
 */
export function nextStrategySort(
  current: EarnStrategySort,
  column: EarnStrategySortColumn
): EarnStrategySort {
  if (current.column !== column) return { column, direction: "desc" };
  return { column, direction: current.direction === "desc" ? "asc" : "desc" };
}

/** The browse step's short list in its default order, highest APY first. */
export function rankedFundableStrategies(
  strategies: readonly EarnStrategy[]
): readonly EarnStrategy[] {
  return sortStrategies(fundableStrategies(strategies), DEFAULT_STRATEGY_SORT);
}

/** Stablecoins the catalogue can fund; used to avoid a redundant table column. */
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
