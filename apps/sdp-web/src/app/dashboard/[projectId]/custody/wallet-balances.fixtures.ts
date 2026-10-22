import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { sol, solToLamports } from "@solana/kit";
import type { WalletTrackedBalancesResult } from "./[walletId]/wallet-detail-balances";

export const READ_AT = 1_700_000_000_000;

/** Native SOL has no display rule: its display amount is its token amount. */
export function solBalance(tokenAmount: string): CustodyWalletTokenBalance {
  return {
    token: "SOL",
    mint: SOL_MINT,
    amount: solToLamports(sol(tokenAmount)).toString(),
    tokenAmount,
    displayAmount: tokenAmount,
    displayAsOf: null,
    displayRule: "plain",
    decimals: 9,
  };
}

export function trackedBalances(
  balances: CustodyWalletTokenBalance[],
  error: string | null
): WalletTrackedBalancesResult {
  return { balances, error, readAt: READ_AT };
}
