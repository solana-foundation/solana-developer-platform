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
  /** Unpriced holdings beyond the cap. Counted, not listed. */
  otherUnpricedCount: number;
}

/**
 * Whether a balance counts as a holding.
 *
 * Deliberately the same rule the wallet page already applies to this same data in
 * `payments/ramps/components/wallet-asset-breakdown.tsx` — a spent token account keeps
 * its aggregate row at zero, and counting those inflated the "Tokens held" tile. An
 * amount that will not parse cannot be counted as a holding either, since nothing
 * downstream can rank or sum it.
 */
function isHeldAmount(balance: CustodyWalletTokenBalance): boolean {
  const amount = Number(balance.uiAmount);
  return Number.isFinite(amount) && amount > 0;
}

/**
 * Whether a balance belongs in the breakdown *list*, which is a looser question than
 * whether it is held.
 *
 * A definite zero is dropped: it contributed a `$0.00` row and an empty segment to an
 * allocation it makes up none of. An unparseable amount is kept, because the list's job
 * is to show what the aggregate returned — hiding a row nobody can explain is worse
 * than showing it as unpriced, which is what the non-finite case here already
 * guarantees.
 */
function isListable(balance: CustodyWalletTokenBalance): boolean {
  const amount = Number(balance.uiAmount);
  return !Number.isFinite(amount) || amount > 0;
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
 * @param unpricedLimit - How many unpriced holdings to list before counting the rest.
 *   Uncapped, an organization issuing twenty tokens turned the card into a ledger.
 */
export function buildHomeBalanceBreakdown(
  balances: CustodyWalletTokenBalance[],
  limit = 4,
  unpricedLimit = 4
): HomeBalanceBreakdown {
  const priced: HomeBalanceSlice[] = [];
  const unpriced: HomeBalanceSlice[] = [];

  for (const balance of balances.filter(isListable)) {
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
    unpriced: unpriced.slice(0, unpricedLimit),
    otherUnpricedCount: Math.max(unpriced.length - unpricedLimit, 0),
    totalUsd: priced.length > 0 ? totalUsd : null,
    otherPricedCount: rest.length,
    otherPricedUsd,
    otherPricedSharePercent: share(otherPricedUsd),
  };
}

/** Distinct tokens held, used for the "Tokens held" tile. */
export function countHeldTokens(balances: CustodyWalletTokenBalance[]): number {
  return new Set(balances.filter(isHeldAmount).map((balance) => balance.mint)).size;
}
