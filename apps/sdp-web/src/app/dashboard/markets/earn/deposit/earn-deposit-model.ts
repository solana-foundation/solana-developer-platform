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
 * Pure model for the Earn deposit flow: profile → filtered catalogue → ONE
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
 * Ground publishes **no** risk tier, rating, or grade on a yield source, so a
 * profile is a transparent FILTER over the observable fields above — never an
 * invented score. The filter vocabulary deliberately mirrors Ground's own
 * `POST /v2/wallets/strategy/optimize` constraints (a settlement ceiling and a
 * pool floor), so a profile can later be handed to that endpoint unchanged.
 */

/** Deposit profiles, ordered from most liquid to highest rate. */
export const EARN_DEPOSIT_PROFILES = ["liquidity", "balanced", "yield"] as const;
export type EarnDepositProfile = (typeof EARN_DEPOSIT_PROFILES)[number];

/** How a filtered catalogue is ordered. */
export const EARN_STRATEGY_SORTS = ["apy", "size", "access"] as const;
export type EarnStrategySort = (typeof EARN_STRATEGY_SORTS)[number];

/** The settlement ceiling the "balanced" profile and its filter chip share. */
export const EARN_SHORT_SETTLEMENT_DAYS = 3;

/**
 * Catalogue filters. `null` always means "no constraint" so an absent provider
 * field can never silently exclude a strategy.
 */
export interface EarnStrategyFilters {
  /** Longest acceptable redemption wait, in whole days. `0` = instant only. */
  maxSettlementDays: number | null;
  /** Minimum reported pool size in USD. */
  minPoolUsd: number | null;
  /** Restrict to one backing kind. */
  sourceKind: EarnStrategySourceKind | null;
  /** Restrict to one funding stablecoin. */
  token: EarnPortfolioToken | null;
  sort: EarnStrategySort;
}

/**
 * Profile presets. The pool floors are deliberately modest — they exist to keep
 * thinly-capitalised sources out of the liquidity-led profiles, not to curate
 * the catalogue. A strategy whose provider reports no pool size is never
 * excluded by a floor (see `matchesFilters`).
 */
const PROFILE_FILTERS: Record<
  EarnDepositProfile,
  Pick<EarnStrategyFilters, "maxSettlementDays" | "minPoolUsd" | "sourceKind">
> = {
  liquidity: { maxSettlementDays: 0, minPoolUsd: 10_000_000, sourceKind: null },
  balanced: {
    maxSettlementDays: EARN_SHORT_SETTLEMENT_DAYS,
    minPoolUsd: 5_000_000,
    sourceKind: null,
  },
  yield: { maxSettlementDays: null, minPoolUsd: null, sourceKind: null },
};

/** The filter set a profile starts the browse step with. */
export function profileFilters(profile: EarnDepositProfile): EarnStrategyFilters {
  return { ...PROFILE_FILTERS[profile], token: null, sort: "apy" };
}

/** Strategies that can actually be funded — i.e. their deposit mint is routable. */
export function fundableStrategies(strategies: readonly EarnStrategy[]): readonly EarnStrategy[] {
  return strategies.filter((strategy) => strategyToken(strategy) !== undefined);
}

/**
 * A filter only excludes on what the provider reported. An unknown pool size
 * passes every floor — the alternative silently empties the catalogue whenever
 * a provider omits `tvlUsd`, which Ground's sandbox routinely does.
 */
export function matchesFilters(strategy: EarnStrategy, filters: EarnStrategyFilters): boolean {
  if (filters.maxSettlementDays !== null && settlementDays(strategy) > filters.maxSettlementDays) {
    return false;
  }
  if (filters.minPoolUsd !== null) {
    const poolUsd = strategyPoolUsd(strategy);
    if (poolUsd !== undefined && poolUsd < filters.minPoolUsd) return false;
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

export interface ProfileSummary {
  profile: EarnDepositProfile;
  count: number;
  /** Best rate the profile can reach right now, as a decimal. */
  topApy: number | undefined;
  /** Fastest settlement any matching strategy offers, in whole days. */
  fastestSettlementDays: number | undefined;
}

/**
 * Live headline figures per profile, so the profile cards state what the
 * catalogue actually holds instead of static marketing copy.
 */
export function profileSummaries(strategies: readonly EarnStrategy[]): readonly ProfileSummary[] {
  const fundable = fundableStrategies(strategies);
  return EARN_DEPOSIT_PROFILES.map((profile) => {
    const matching = fundable.filter((strategy) =>
      matchesFilters(strategy, profileFilters(profile))
    );
    const apys = matching
      .map((strategy) => strategyApy(strategy))
      .filter((apy): apy is number => apy !== undefined);
    return {
      profile,
      count: matching.length,
      topApy: apys.length > 0 ? Math.max(...apys) : undefined,
      fastestSettlementDays:
        matching.length > 0 ? Math.min(...matching.map(settlementDays)) : undefined,
    };
  });
}

/**
 * The program request for a single chosen strategy: 100% of that strategy's
 * stablecoin group. The API validates weights on a 0.1 grid summing to exactly
 * 100 per group, and omitted groups keep their current allocation — so picking
 * a USDC strategy never disturbs an existing USDT strategy.
 */
export function singleStrategyAllocation(
  strategy: EarnStrategy
): EarnPortfolioAllocationInput | undefined {
  const token = strategyToken(strategy);
  if (!token) return undefined;
  return { [token]: [{ yieldSourceId: strategy.providerReference, pct: 100 }] };
}
