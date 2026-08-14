import type { EarnPortfolioAllocationInput, EarnPortfolioToken, EarnStrategy } from "@sdp/types";
import { strategyApy, strategyToken } from "../earn-program-presentation";

/**
 * Pure model for the Earn deposit flow: full catalogue → APY-ranked fundable
 * rows → ONE strategy → a 100% allocation.
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
 * integrator can browse the real shelf. Offering one of those rows in the
 * wizard would walk a user to a confirm step that provisions nothing.
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

function descendingUnknownLast(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

/** The browse step's short list, highest indicative APY first. */
export function rankedFundableStrategies(
  strategies: readonly EarnStrategy[]
): readonly EarnStrategy[] {
  return [...fundableStrategies(strategies)].sort((left, right) =>
    descendingUnknownLast(strategyApy(left), strategyApy(right))
  );
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
