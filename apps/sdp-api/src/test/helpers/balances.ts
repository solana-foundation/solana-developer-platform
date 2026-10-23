import type { CustodyWalletTokenBalance } from "@sdp/types/custody";

/** A balance whose display is its token amount (native SOL, a classic SPL mint). */
export function plainTokenBalance(balance: {
  token: string;
  mint: string;
  amount: string;
  tokenAmount: string;
  decimals: number;
}): CustodyWalletTokenBalance {
  return {
    ...balance,
    displayAmount: balance.tokenAmount,
    displayAsOf: null,
    displayRule: "plain",
  };
}
