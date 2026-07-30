import type { CustodyWalletTokenBalance } from "@sdp/types";

export interface HomeBalanceSlice {
  /** Mint address — the stable identity, and the React key. */
  mint: string;
  /** Raw token field from the aggregate; the renderer resolves the display symbol. */
  token: string;
  uiAmount: string;
  usdValue: number | null;
  /** 0-100, relative to the largest holding rather than to the total. */
  sharePercent: number;
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
 * Orders holdings for the home breakdown, largest first.
 *
 * Bars are scaled against the **largest** holding, not the portfolio total: with one
 * dominant asset every other bar would round to an invisible sliver, which reads as
 * "no data" rather than "small position". Priced holdings sort above unpriced ones so
 * a token we cannot value never outranks one we can.
 *
 * @param balances - Aggregate token balances, already summed across wallets.
 * @param limit - Maximum rows to return.
 */
export function buildHomeBalanceBreakdown(
  balances: CustodyWalletTokenBalance[],
  limit = 5
): HomeBalanceSlice[] {
  const slices = balances.map((balance) => ({
    mint: balance.mint,
    token: balance.token,
    uiAmount: balance.uiAmount,
    usdValue: usdValueOf(balance),
  }));

  slices.sort((a, b) => {
    if (a.usdValue === null && b.usdValue === null) return 0;
    if (a.usdValue === null) return 1;
    if (b.usdValue === null) return -1;
    return b.usdValue - a.usdValue;
  });

  const largest = slices.reduce(
    (max, slice) => (slice.usdValue !== null && slice.usdValue > max ? slice.usdValue : max),
    0
  );

  return slices.slice(0, limit).map((slice) => ({
    ...slice,
    sharePercent:
      largest > 0 && slice.usdValue !== null
        ? Math.max(2, Math.round((slice.usdValue / largest) * 100))
        : 0,
  }));
}

/** Distinct tokens held, used for the "Tokens held" tile. */
export function countHeldTokens(balances: CustodyWalletTokenBalance[]): number {
  return new Set(balances.map((balance) => balance.mint)).size;
}
