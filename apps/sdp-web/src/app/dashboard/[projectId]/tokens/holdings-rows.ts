import type { CustodyWalletTokenBalance } from "@sdp/types";

export interface HoldingRow {
  /** Mint address — the stable identity, and the React key. */
  mint: string;
  /** Raw token field from the aggregate; the renderer resolves the display symbol. */
  token: string;
  uiAmount: string;
  /** Null when nothing prices this holding. */
  usdValue: number | null;
  /** Share of the priced total, 0-100. Null for unpriced holdings, which are not part of one. */
  sharePercent: number | null;
}

/**
 * Whether a balance counts as a holding.
 *
 * Same rule the home allocation card applies to this same data: a spent token
 * account keeps its aggregate row at zero, and listing those pads the page with
 * rows an organization no longer holds.
 */
function isHeld(balance: CustodyWalletTokenBalance): boolean {
  const amount = Number(balance.uiAmount);
  return Number.isFinite(amount) && amount > 0;
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
 * Every holding an organization has, ranked.
 *
 * The home page deliberately caps at four priced and four unpriced holdings so the
 * card stays a summary — which left an organization holding a dozen tokens with a
 * count it could not open. This is the surface that count leads to, so it caps
 * nothing.
 *
 * Priced holdings rank above unpriced ones because a dollar figure is the stronger
 * signal, and unpriced holdings carry a null share rather than zero: they are not
 * part of the priced total, and rendering them as 0% reads as "worthless" instead
 * of "not measured here".
 */
export function buildHoldingsRows(balances: CustodyWalletTokenBalance[]): HoldingRow[] {
  const priced: HoldingRow[] = [];
  const unpriced: HoldingRow[] = [];

  for (const balance of balances.filter(isHeld)) {
    const usdValue = usdValueOf(balance);
    const row: HoldingRow = {
      mint: balance.mint,
      token: balance.token,
      uiAmount: balance.uiAmount,
      usdValue,
      sharePercent: null,
    };
    if (usdValue === null) {
      unpriced.push(row);
    } else {
      priced.push(row);
    }
  }

  priced.sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0));
  unpriced.sort((a, b) => Number(b.uiAmount) - Number(a.uiAmount));

  const total = priced.reduce((sum, row) => sum + (row.usdValue ?? 0), 0);
  for (const row of priced) {
    row.sharePercent = total > 0 ? ((row.usdValue ?? 0) / total) * 100 : 0;
  }

  return [...priced, ...unpriced];
}
