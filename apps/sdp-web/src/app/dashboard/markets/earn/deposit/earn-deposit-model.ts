import type {
  EarnPortfolioAllocationInput,
  EarnPortfolioToken,
  EarnProviderId,
  EarnStrategy,
} from "@sdp/types";
import { strategyApy, strategyPoolUsd, strategyToken } from "../earn-program-presentation";

/**
 * Pure model for the Earn deposit flow: full catalogue → ranked comparison
 * rows (APY by default, or whichever column the reader ranked by) → ONE
 * deposit-eligible strategy → a 100% allocation.
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

/**
 * Strategies that can actually be funded: their deposit mint is routable AND
 * the API says the instrument exists on this environment's cluster.
 *
 * The `fundable` half is not decoration. The catalogue lists what EXISTS, which
 * since Kamino is a larger set than what can take a deposit here — Kamino's
 * K-Vaults are mainnet-only and are catalogued into sandbox too, so an
 * integrator can browse the real shelf. Making one of those rows selectable in
 * the wizard would walk a user to a confirm step that provisions nothing.
 *
 * The API derives the flag per request (`hostCluster` vs. the caller's
 * environment) and its own `assertKnownYieldSources` refuses the allocation
 * regardless, so this is the second of two independent guards, not the only
 * one. Never invert it into "hide unless known-bad".
 */
export function fundableStrategies(strategies: readonly EarnStrategy[]): readonly EarnStrategy[] {
  // `!== false`, NOT a truthiness check. The API is a separate deployable, so
  // the type's promise that `fundable` is always present describes the CURRENT
  // API, not necessarily the one answering: a Vercel preview (web-only, pointed
  // at the deployed API) and any rollout where web ships ahead of API both see
  // responses without the field. Truthiness there reads `undefined` as "not
  // fundable" and blanks the ENTIRE catalogue — which is exactly what happened
  // on the first preview of this branch.
  //
  // Absent is safe to admit: an API old enough to omit `fundable` is an API
  // without a mainnet-only provider registered, so its catalogue holds no row
  // this filter would need to hide. Once the API ships, the field is always
  // present and the strict comparison does the real work.
  return strategies.filter(
    (strategy) => strategy.fundable !== false && strategyToken(strategy) !== undefined
  );
}

/** Why a catalogue row cannot advance through this portfolio-deposit flow. */
export type StrategyDepositEligibility =
  | "eligible"
  | "environment-mismatch"
  | "provider-unsupported"
  | "asset-unsupported";

/**
 * Keep catalogue visibility separate from deposit eligibility.
 *
 * The comparison table shows every active strategy the API returns. Selection
 * is narrower: the instrument must exist on this project's cluster, the
 * provider must implement the portfolio flow this wizard drives, and its mint
 * must map to one of Earn's supported stablecoin lanes.
 *
 * Environment mismatch wins when more than one reason applies. That gives a
 * sandbox reader the most actionable explanation for a mainnet-only Kamino
 * row, while the provider-capability guard still prevents that row from being
 * selected in production until a real Kamino deposit path exists.
 */
export function strategyDepositEligibility(
  strategy: EarnStrategy,
  portfolioProvider: EarnProviderId
): StrategyDepositEligibility {
  if (strategy.fundable === false) return "environment-mismatch";
  if (strategy.provider !== portfolioProvider) return "provider-unsupported";
  if (strategyToken(strategy) === undefined) return "asset-unsupported";
  return "eligible";
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

/** The full visible catalogue in its initial comparison order. */
export function rankedStrategies(strategies: readonly EarnStrategy[]): readonly EarnStrategy[] {
  return sortStrategies(strategies, DEFAULT_STRATEGY_SORT);
}

/** Stablecoins represented in the visible catalogue; avoids a redundant column. */
export function availableTokens(
  strategies: readonly EarnStrategy[]
): readonly EarnPortfolioToken[] {
  const tokens = new Set<EarnPortfolioToken>();
  for (const strategy of strategies) {
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
