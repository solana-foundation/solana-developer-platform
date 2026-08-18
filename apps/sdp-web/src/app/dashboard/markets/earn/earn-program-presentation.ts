"use client";

import {
  EARN_PORTFOLIO_TOKENS,
  type EarnPortfolioPosition,
  type EarnPortfolioTargetAllocations,
  type EarnPortfolioToken,
  type EarnStrategy,
  earnCuratorLabel,
  WELL_KNOWN_TOKEN_BY_MINT,
} from "@sdp/types";
import { useTranslations } from "@/i18n/provider";

/**
 * Shared strategy presentation helpers for every Earn surface (overview,
 * deposit flow, and future program views). All helpers are pure over live
 * `EarnStrategy` catalogue rows — callers fetch the rows from the strategies
 * BFF and pass them in; nothing here holds module-level data.
 *
 * Every value is read from a field the provider actually publishes. Ground
 * reports **no** risk tier, rating, or grade on a yield source (its own docs:
 * "No risk classifications, tiers, or ratings are included in this catalog"),
 * so nothing here invents one — the observable facts are the rate, what backs
 * it, how fast it redeems, and how large the pool is.
 */

/** Portfolio token (usdc/usdt) behind a deposit mint, when the rail routes it. */
export function portfolioTokenForMint(mint: string): EarnPortfolioToken | undefined {
  const symbol = WELL_KNOWN_TOKEN_BY_MINT.get(mint)?.symbol.toLowerCase();
  return EARN_PORTFOLIO_TOKENS.find((token) => token === symbol);
}

/**
 * The stablecoin group a strategy funds. A provider keys a yield source to
 * exactly one deposit token, so the first routable mint is the group; a
 * strategy whose mints do not map to a portfolio token cannot be funded here.
 */
export function strategyToken(strategy: EarnStrategy): EarnPortfolioToken | undefined {
  for (const mint of strategy.depositMints) {
    const token = portfolioTokenForMint(mint);
    if (token) return token;
  }
  return undefined;
}

/**
 * Whole days until a redemption settles: instant is 0, and a delayed strategy
 * missing its day count reads as 1 (the provider mapping already rounds up, so
 * this only covers a row written without one).
 */
export function settlementDays(strategy: EarnStrategy): number {
  if (strategy.liquidityTerm === "instant") return 0;
  return strategy.redemptionDelayDays ?? 1;
}

/** Reported pool size in USD, when the catalogue sync recorded one. */
export function strategyPoolUsd(strategy: EarnStrategy): number | undefined {
  const tvlUsd = strategy.riskMetadata?.tvlUsd;
  return typeof tvlUsd === "number" && Number.isFinite(tvlUsd) ? tvlUsd : undefined;
}

/** Numeric APY as a decimal (`0.052` = 5.2%), or undefined when unreported. */
export function strategyApy(strategy: EarnStrategy): number | undefined {
  if (strategy.currentApy === undefined) return undefined;
  const apy = Number(strategy.currentApy);
  return Number.isFinite(apy) ? apy : undefined;
}

/**
 * Display label for the house curating a strategy, when the catalogue row
 * carries one. Curator is **metadata only** on every Earn surface: it is shown
 * beside a strategy, never selected first and never a gate.
 */
export function strategyCuratorLabel(strategy: EarnStrategy): string | undefined {
  const curator = strategy.riskMetadata?.curator;
  if (typeof curator !== "string" || curator.trim() === "") return undefined;
  return earnCuratorLabel(curator.trim());
}

/** Display label for the protocol or fund the strategy sits on. */
export function strategySourceLabel(strategy: EarnStrategy): string | undefined {
  const source = strategy.underlyingSource?.trim();
  return source ? earnCuratorLabel(source) : undefined;
}

/** Human liquidity term for a strategy (Instant or T+n). */
export function useLiquidityLabel() {
  const t = useTranslations();
  return (strategy: EarnStrategy): string => {
    if (strategy.liquidityTerm === "instant") {
      return t("DashboardEarn.liquidity.instant");
    }
    return t("DashboardEarn.liquidity.delayed", { days: strategy.redemptionDelayDays ?? 1 });
  };
}

/*
 * `withdrawLanes()` lived here until PRO-1675 and is deliberately GONE.
 *
 * It reconstructed a per-stablecoin withdrawal ceiling in the browser by
 * joining position values to the catalogue, folding every unattributable slice
 * into each lane, and capping at the wallet total. Its own doc comment called
 * it an ESTIMATE and pointed at the withdrawal preview as "the authority that
 * catches that" — but the preview was never asked until the reader had already
 * typed an amount, so nothing caught it in time and `Max` could offer a figure
 * the provider answered with a 409.
 *
 * The withdraw modal now asks the provider directly, on open, with an
 * amount-less preview. Do not reintroduce a client-side ceiling: if the read is
 * pending or failed the modal shows no number and validates shape only, which
 * is the honest state — the provider is the authority, and money out must never
 * be blocked by a read we could not complete (ADR 0002).
 */

/**
 * The catalogue keyed by provider reference, filtered to ONE provider — the
 * join every per-program surface performs (holdings, title, withdraw lanes'
 * cousin). Filtering is part of the contract: provider references are only
 * unique within a provider, so an unfiltered map could cross-match another
 * provider's strategy onto this program's slices. Build it once per catalogue
 * change and pass it down, not once per consumer.
 */
export function strategiesByReference(
  provider: string,
  strategies: readonly EarnStrategy[]
): ReadonlyMap<string, EarnStrategy> {
  return new Map(
    strategies
      .filter((strategy) => strategy.provider === provider)
      .map((strategy) => [strategy.providerReference, strategy] as const)
  );
}

/**
 * A program's display name, derived from the vault it targets rather than the
 * program id.
 *
 * Nobody thinks of a program as `earn_provider_wallet_<uuid>` — they think of it
 * as "the Kamino USDC one". V1 pins each program to a single vault per token
 * lane, so the target allocation IS the identity.
 *
 * **Two independent name sources, and the second is not optional.** The
 * catalogue is tried first (canonical, and it names a target even when no money
 * has landed on it yet), then the wallet's own POSITION labels. That fallback
 * exists because the catalogue a browser can see is a filtered view: the API
 * hides un-surfaced providers and Aave/Morpho-related rows, so a program held
 * with an un-surfaced provider looks up its own vault and finds nothing —
 * which rendered every Ground program as "Unnamed strategy" the moment Ground
 * stopped being offered.
 *
 * Position labels are the right fallback because they arrive display-ready from
 * the provider client and are already rendered directly beneath this title in
 * "Where the money sits". A card that names its vault in the holdings list and
 * calls itself "Unnamed" is stating two different things about one program.
 *
 * This is the presentation half of an ADR 0002 rule: browse visibility must
 * never decide what a customer can see about money they already hold.
 */
export function programTitle(
  allocations: EarnPortfolioTargetAllocations,
  positions: readonly EarnPortfolioPosition[],
  label: string | null,
  byReference: ReadonlyMap<string, EarnStrategy>,
  fallback: string
): string {
  const names: string[] = [];
  for (const token of EARN_PORTFOLIO_TOKENS) {
    for (const entry of allocations[token] ?? []) {
      if (entry.yieldSourceId === "cash" || entry.weightBps <= 0) continue;
      const name = byReference.get(entry.yieldSourceId)?.name;
      if (name && !names.includes(name)) names.push(name);
    }
  }
  if (names.length > 0) return names.join(" · ");

  // Provider-reported, so it survives any catalogue filter. Only `yield_source`
  // slices name a vault — a cash bucket's label ("Cash (USDC)") is a rail, not
  // an identity, and titling a program with it would be worse than the fallback.
  for (const position of positions) {
    if (position.kind !== "yield_source") continue;
    const name = position.label.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  if (names.length > 0) return names.join(" · ");

  return label ?? fallback;
}

/** Aggregate money across every program the organization holds. */
export interface PortfolioTotals {
  totalUsd: number;
  earnedUsd: number;
  withdrawableUsd: number;
  /**
   * Balance-weighted APY as a decimal, or undefined when it cannot be stated
   * honestly — see {@link portfolioTotals}.
   */
  blendedApy: number | undefined;
}

/**
 * Portfolio-level totals across programs.
 *
 * The blended APY is deliberately all-or-nothing: it is reported only when
 * EVERY program holding money also reports a rate. Weighting over just the
 * programs that happen to publish one would quote the rate of a small funded
 * strategy as though it were the whole portfolio's — the module's standing rule
 * is that a missing number renders as "—", never as a fabricated or partial
 * one.
 */
export function portfolioTotals(
  programs: readonly {
    wallet: { balance: { totalUsd: string; earnedUsd: string; withdrawableUsd: string } };
    yield?: { currentApy?: string };
  }[]
): PortfolioTotals {
  let totalUsd = 0;
  let earnedUsd = 0;
  let withdrawableUsd = 0;
  let weightedApy = 0;
  let ratedUsd = 0;
  let ratesComplete = true;

  for (const program of programs) {
    const balance = Number(program.wallet.balance.totalUsd) || 0;
    totalUsd += balance;
    earnedUsd += Number(program.wallet.balance.earnedUsd) || 0;
    withdrawableUsd += Number(program.wallet.balance.withdrawableUsd) || 0;

    const apy = program.yield?.currentApy ? Number(program.yield.currentApy) : undefined;
    if (apy !== undefined && Number.isFinite(apy)) {
      weightedApy += apy * balance;
      ratedUsd += balance;
    } else if (balance > 0) {
      ratesComplete = false;
    }
  }

  return {
    totalUsd,
    earnedUsd,
    withdrawableUsd,
    blendedApy: ratesComplete && ratedUsd > 0 ? weightedApy / ratedUsd : undefined,
  };
}
