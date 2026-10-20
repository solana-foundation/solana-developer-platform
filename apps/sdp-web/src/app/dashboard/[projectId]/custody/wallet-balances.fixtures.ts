import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import { SOL_MINT } from "@sdp/types/well-known-tokens";
import { sol, solToLamports } from "@solana/kit";
import type { WalletTrackedBalancesResult } from "./[walletId]/wallet-detail-balances";

export const READ_AT = 1_700_000_000_000;

export function solBalance(uiAmount: string): CustodyWalletTokenBalance {
  return {
    token: "SOL",
    mint: SOL_MINT,
    amount: solToLamports(sol(uiAmount)).toString(),
    uiAmount,
    decimals: 9,
  };
}

export function trackedBalances(
  balances: CustodyWalletTokenBalance[],
  error: string | null
): WalletTrackedBalancesResult {
  return { balances, error, readAt: READ_AT };
}
