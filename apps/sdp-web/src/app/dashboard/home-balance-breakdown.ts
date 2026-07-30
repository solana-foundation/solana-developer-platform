import type { CustodyWalletTokenBalance } from "@sdp/types";

export interface HomeBalanceSlice {
  /** Mint address — the stable identity, and the React key. */
  mint: string;
  /** Raw token field from the aggregate; the renderer resolves the display symbol. */
  token: string;
  uiAmount: string;
  /** Present only on priced holdings. */
  usdValue: number | null;
  /** Share of the total priced value, 0-100. Zero for unpriced holdings. */
  sharePercent: number;
}

export interface HomeBalanceBreakdown {
  /** Holdings with a USD value, largest first — these compose the allocation bar. */
  priced: HomeBalanceSlice[];
  /** Holdings with no price feed, largest amount first. Never charted. */
  unpriced: HomeBalanceSlice[];
  /** Sum of every priced holding, or null when nothing is priced. */
  totalUsd: number | null;
  /** Priced holdings dropped from `priced` after the cap, folded into one bucket. */
  otherPricedCount: number;
  otherPricedUsd: number;
  otherPricedSharePercent: number;
}

function usdValueOf(balance: CustodyWalletTokenBalance): number | null {
  if (typeof balance.usdValue === "number" && Number.isFinite(balance.usdValue)) {
    return balance.usdValue;
  }
  if (typeof balance.usdPrice === "number" && Number.isFinite(balance.usdPrice)) {
    const amount = Number(balance.uiAmount);
    if (Number.isFinite(amount)) {
      return amount * balance.usdPrice;
    }
  }
  return null;
}

/**
 * Splits holdings into what can be compared and what cannot.
 *
 * An organization's own issued tokens have no price feed, so their balance is an
 * amount and nothing more. Ranking `132.5 nwSOL` against `$149.11` on one scale is a
 * category error — the earlier version drew a share bar for every row and the
 * unpriced ones came out as empty full-width rules that read as dividers. Only
 * priced holdings get a share; unpriced ones are returned separately so the caller
 * can list them without pretending they are part of an allocation.
 *
 * Shares are of the **priced total**, so the segments of a stacked bar sum to 100.
 *
 * @param balances - Aggregate token balances, already summed across wallets.
 * @param limit - How many priced holdings to name before folding the rest into "Other".
 */
export function buildHomeBalanceBreakdown(
  balances: CustodyWalletTokenBalance[],
  limit = 4
): HomeBalanceBreakdown {
  const priced: HomeBalanceSlice[] = [];
  const unpriced: HomeBalanceSlice[] = [];

  for (const balance of balances) {
    const usdValue = usdValueOf(balance);
    const slice: HomeBalanceSlice = {
      mint: balance.mint,
      token: balance.token,
      uiAmount: balance.uiAmount,
      usdValue,
      sharePercent: 0,
    };
    if (usdValue === null) {
      unpriced.push(slice);
    } else {
      priced.push(slice);
    }
  }

  priced.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
  unpriced.sort((a, b) => Number(b.uiAmount) - Number(a.uiAmount));

  const totalUsd = priced.reduce((sum, slice) => sum + (slice.usdValue ?? 0), 0);
  const share = (value: number) => (totalUsd > 0 ? (value / totalUsd) * 100 : 0);

  const named = priced.slice(0, limit).map((slice) => ({
    ...slice,
    sharePercent: share(slice.usdValue ?? 0),
  }));
  const rest = priced.slice(limit);
  const otherPricedUsd = rest.reduce((sum, slice) => sum + (slice.usdValue ?? 0), 0);

  return {
    priced: named,
    unpriced,
    totalUsd: priced.length > 0 ? totalUsd : null,
    otherPricedCount: rest.length,
    otherPricedUsd,
    otherPricedSharePercent: share(otherPricedUsd),
  };
}

/** Distinct tokens held, used for the "Tokens held" tile. */
export function countHeldTokens(balances: CustodyWalletTokenBalance[]): number {
  return new Set(balances.map((balance) => balance.mint)).size;
}
