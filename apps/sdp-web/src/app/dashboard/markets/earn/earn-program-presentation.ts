"use client";

import {
  EARN_PORTFOLIO_TOKENS,
  type EarnPortfolioPosition,
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

/** Portfolio value split by stablecoin lane. See {@link withdrawLanes}. */
export interface WithdrawLanes {
  /** USD value attributable to each stablecoin lane. */
  totals: ReadonlyMap<EarnPortfolioToken, number>;
  /**
   * Value whose lane could not be resolved: no token on the wire and no
   * catalogue row for its yield source (e.g. the catalogue read is still in
   * flight). Callers count it toward EVERY lane's ceiling, so an incomplete
   * join can only over-allow — the withdrawal preview is the authority that
   * catches that — and never block an amount the provider would fill.
   */
  unattributedUsd: number;
}

/**
 * Per-stablecoin value held in the program. `withdrawableUsd` is wallet-level
 * while Ground fills withdrawals per lane (it never converts between
 * stablecoins), so a withdraw surface must scope what it promises to the
 * selected token. Cash and in-transit slices carry their token on the wire;
 * deployed slices resolve through the catalogue by yield-source reference —
 * the same join the dashboard holdings use. An ESTIMATE (position values, not
 * a net-of-reserve quote): cap it at the wallet-level withdrawable.
 */
export function withdrawLanes(
  positions: readonly EarnPortfolioPosition[],
  strategies: readonly EarnStrategy[]
): WithdrawLanes {
  const laneByReference = new Map(
    strategies.map((strategy) => [strategy.providerReference, strategyToken(strategy)])
  );
  const totals = new Map<EarnPortfolioToken, number>();
  let unattributedUsd = 0;
  for (const position of positions) {
    const value = Number(position.valueUsd);
    if (!Number.isFinite(value) || value <= 0) continue;
    const token =
      position.token ??
      (position.yieldSourceId ? laneByReference.get(position.yieldSourceId) : undefined);
    if (token) totals.set(token, (totals.get(token) ?? 0) + value);
    else unattributedUsd += value;
  }
  return { totals, unattributedUsd };
}
