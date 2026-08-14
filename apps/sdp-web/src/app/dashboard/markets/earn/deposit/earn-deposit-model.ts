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
 * (the only provider this flow can start a program with — see
 * `EARN_PROGRAM_PROVIDERS`) the catalogue row is mapped from
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

/**
 * Providers this flow can create a PROGRAM with, i.e. those exposing SDP the
 * portfolio-wallet capability.
 *
 * Deliberately a set, not the single `EARN_PORTFOLIO_PROVIDER` pin: the
 * catalogue now lists providers the flow cannot fund, so "which provider do we
 * post to" and "which rows may be selected" stopped being the same question.
 * Kamino is absent because a K-Vault is non-custodial — the customer's own
 * wallet deposits on-chain, so there is no program for SDP to create and
 * `POST /v1/earn/programs` answers 501 for it by capability detection.
 *
 * This mirrors a server fact rather than owning it: the API is authoritative
 * and refuses regardless. Keeping the list here is what stops the wizard
 * offering a row whose confirm could only fail. Add an id once its execution
 * path actually exists, never to make a vault look available.
 */
const EARN_PROGRAM_PROVIDERS: readonly string[] = ["ground"];

/** Why a catalogued strategy cannot start a program from this flow. */
export type StrategyUnavailability = "not_on_this_cluster" | "no_program_support";

/**
 * The reason a row is browse-only, or undefined when it can be selected.
 *
 * Order matters: the cluster answer is checked FIRST because it is the more
 * specific and more actionable of the two. A Kamino vault in sandbox is both
 * off-cluster and unsupported; "this exists on mainnet only" tells the reader
 * something they can act on (switch environment), while "not available through
 * SDP" reads as permanent and is what they should see in production.
 */
export function strategyUnavailability(strategy: EarnStrategy): StrategyUnavailability | undefined {
  // `=== false`, NOT falsy. The API is a separate deployable, so the type's
  // promise that `fundable` is always present describes the CURRENT API, not
  // necessarily the one answering: a Vercel preview (web-only, pointed at the
  // deployed API) and any rollout where web ships ahead of API both see
  // responses without the field. Reading `undefined` as "not fundable" would
  // mark every row browse-only and zero the hero's counts — the same mistake
  // that, before the table listed browse-only rows, blanked the catalogue
  // outright on this branch's first preview.
  //
  // Absent is safe to admit: an API old enough to omit the field has no
  // mainnet-only provider registered, so it cannot be serving a row that needs
  // hiding.
  if (strategy.fundable === false) return "not_on_this_cluster";
  if (!EARN_PROGRAM_PROVIDERS.includes(strategy.provider)) return "no_program_support";
  return undefined;
}

/** A strategy the flow can actually start a program with. */
export function isStrategySelectable(strategy: EarnStrategy): boolean {
  return strategyUnavailability(strategy) === undefined;
}

/**
 * Every strategy the catalogue table LISTS — all providers, all clusters.
 *
 * The catalogue and the fundable set are different sets, and since Kamino the
 * difference is the point: SDP serves the communal vaults, so the shelf shows
 * what exists. Rows that cannot start a program are rendered browse-only with
 * the reason from `strategyUnavailability`, never silently dropped — hiding
 * them made the whole Kamino integration invisible in the dashboard.
 *
 * The token lane is still required: it drives the token column and filter, and
 * a row without one has nothing to render there.
 */
export function browsableStrategies(strategies: readonly EarnStrategy[]): readonly EarnStrategy[] {
  return strategies.filter((strategy) => strategyToken(strategy) !== undefined);
}

/**
 * Strategies that can actually be funded: routable deposit mint, a provider
 * that supports programs, and an instrument the API says exists on this
 * environment's cluster.
 *
 * Drives the onboarding hero's counts — NOT the catalogue table, which uses
 * `browsableStrategies`. The hero is a call to action for setting up a program,
 * so counting a vault the flow cannot fund would advertise an option (and a top
 * APY) the reader cannot reach.
 */
export function fundableStrategies(strategies: readonly EarnStrategy[]): readonly EarnStrategy[] {
  return browsableStrategies(strategies).filter(isStrategySelectable);
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

/**
 * The browse step's list: the whole catalogue, filtered and sorted. Never
 * mutates the input. Browsable rather than fundable — selectability is a
 * per-ROW property, not a reason to omit the row.
 */
export function visibleStrategies(
  strategies: readonly EarnStrategy[],
  filters: EarnStrategyFilters
): readonly EarnStrategy[] {
  const matching = browsableStrategies(strategies).filter((strategy) =>
    matchesFilters(strategy, filters)
  );
  return [...matching].sort(COMPARATORS[filters.sort]);
}

/**
 * The stablecoins the catalogue lists, for the token filter chips.
 *
 * Browsable, matching the table: a filter offering a token whose only rows are
 * browse-only would still be honest — those rows render — whereas omitting it
 * would hide vaults the table otherwise shows.
 */
export function availableTokens(
  strategies: readonly EarnStrategy[]
): readonly EarnPortfolioToken[] {
  const tokens = new Set<EarnPortfolioToken>();
  for (const strategy of browsableStrategies(strategies)) {
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
