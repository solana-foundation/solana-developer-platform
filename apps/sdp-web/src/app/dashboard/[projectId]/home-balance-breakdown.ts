import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { isHeldBalance } from "./payments/payments-overview.utils";

/**
 * Distinct tokens held, used for the "Tokens held" tile. The same holdings rule as the balance
 * list beside it (`normalizeAggregateBalances`) and the wallet page's breakdown, so a spent token
 * account that keeps its row at zero is never counted.
 */
export function countHeldTokens(balances: CustodyWalletTokenBalance[]): number {
  return new Set(balances.filter(isHeldBalance).map((balance) => balance.mint)).size;
}
