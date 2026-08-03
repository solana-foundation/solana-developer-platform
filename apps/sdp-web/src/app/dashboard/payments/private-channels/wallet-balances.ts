"use server";

import {
  fetchPrivateChannelBalance,
  fetchSignableWalletsWithBalances,
} from "@/lib/private-channels";
import { createSdpApiClient } from "@/lib/sdp-api";

export interface WalletBalanceView {
  /** Channel-side USDC balance (SPC gateway). Null when the read failed. */
  channel: string | null;
  /** On-chain USDC balance in the wallet's devnet ATA. Null when the read failed. */
  onChain: string | null;
}

/**
 * Read both the channel USDC balance and the wallet's on-chain USDC for the
 * given wallet, in parallel. Individual failures degrade to `null` rather than
 * throwing — the UI treats missing balances as "not available" rather than an
 * error state.
 */
export async function fetchWalletBalancesAction(walletId: string): Promise<WalletBalanceView> {
  if (!walletId) return { channel: null, onChain: null };
  const client = await createSdpApiClient();
  const [channelResult, walletsResult] = await Promise.allSettled([
    fetchPrivateChannelBalance(client, walletId),
    fetchSignableWalletsWithBalances(client),
  ]);
  const channel = channelResult.status === "fulfilled" ? channelResult.value : null;
  const wallets = walletsResult.status === "fulfilled" ? walletsResult.value : [];
  const wallet = wallets.find((w) => w.walletId === walletId);
  const onChainToken =
    channel && wallet?.balances ? wallet.balances.find((b) => b.mint === channel.mint) : null;
  return {
    channel: channel?.uiAmount ?? null,
    onChain: onChainToken?.uiAmount ?? (wallet ? "0" : null),
  };
}
