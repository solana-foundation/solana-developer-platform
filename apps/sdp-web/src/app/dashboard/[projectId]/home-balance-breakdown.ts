import type { CustodyWalletTokenBalance } from "@sdp/types/custody";

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

/** Distinct tokens held, used for the "Tokens held" tile. */
export function countHeldTokens(balances: CustodyWalletTokenBalance[]): number {
  return new Set(balances.filter(isHeldAmount).map((balance) => balance.mint)).size;
}
