import {
  EARN_PORTFOLIO_TOKENS,
  type EarnPortfolioToken,
  type EarnStrategy,
  earnCuratorLabel,
} from "@sdp/types/earn";
import { WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import type { MessageKey } from "@/i18n/messages";
import type { TranslationValues } from "@/i18n/translate";

/**
 * Shared strategy presentation helpers for every Earn surface (overview,
 * deposit flow, and future program views). All helpers are pure over live
 * `EarnStrategy` catalogue rows — callers fetch the rows from the strategies
 * BFF and pass them in; nothing here holds module-level strategy data.
 *
 * Every value is read from a field the provider actually publishes. The
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
 * Underlying sources whose label describes the asset rather than naming a
 * brand. That makes it copy, so it is translated like any other.
 */
const DESCRIBED_SOURCE_LABELS = new Map<string, MessageKey>([
  ["figure-democratized-prime-home-equity", "DashboardEarn.deposit.vaultBackingFigureHomeEquity"],
]);

/**
 * Underlying sources a provider reports by id rather than by name (Kamino's lending protocol
 * is `klend`). The names are brands, so they read the same in every locale.
 */
const BRANDED_SOURCE_LABELS = {
  klend: "Kamino Lend",
  "ondo-usdy": "Ondo USDY",
} as const satisfies Record<string, string>;

function isBrandedSource(source: string): source is keyof typeof BRANDED_SOURCE_LABELS {
  return Object.hasOwn(BRANDED_SOURCE_LABELS, source);
}

/** Display label for the protocol or fund the strategy sits on. */
export function strategySourceLabel(
  strategy: Pick<EarnStrategy, "underlyingSource">,
  t: (key: MessageKey, values?: TranslationValues) => string
): string | undefined {
  const source = strategy.underlyingSource?.trim();
  if (!source) return undefined;
  const described = DESCRIBED_SOURCE_LABELS.get(source);
  if (described) return t(described);
  return isBrandedSource(source) ? BRANDED_SOURCE_LABELS[source] : earnCuratorLabel(source);
}
