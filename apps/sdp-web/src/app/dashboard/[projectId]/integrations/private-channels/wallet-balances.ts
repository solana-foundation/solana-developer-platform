"use server";

import {
  fetchPrivateChannelBalance,
  fetchSignableWalletsWithBalances,
} from "@/lib/private-channels";
import { createSdpApiClient } from "@/lib/sdp-api";

export interface WalletBalanceView {
  /** Channel-side balance for the selected mint (SPC gateway). Null when the read failed. */
  channel: string | null;
  /** On-chain balance in the wallet's ATA for the selected mint. Null when the read failed. */
  onChain: string | null;
}

/**
 * Read both the channel balance and the wallet's on-chain balance for one mint,
 * in parallel. Individual failures degrade to `null` rather than throwing — the
 * UI treats missing balances as "not available" rather than an error state.
 *
 * `mint` is omitted when the caller has no token list (a degraded instance read),
 * in which case the API falls back to the instance's first allowed token and the
 * on-chain side matches whatever mint it reports.
 */
export async function fetchWalletBalancesAction(
  walletId: string,
  mint?: string
): Promise<WalletBalanceView> {
  if (!walletId) return { channel: null, onChain: null };
  const client = await createSdpApiClient();
  const [channelResult, walletsResult] = await Promise.allSettled([
    fetchPrivateChannelBalance(client, walletId, mint),
    fetchSignableWalletsWithBalances(client),
  ]);
  const channel = channelResult.status === "fulfilled" ? channelResult.value : null;
  const wallets = walletsResult.status === "fulfilled" ? walletsResult.value : [];
  const wallet = wallets.find((w) => w.walletId === walletId);
  // Prefer the requested mint; fall back to whichever the channel read resolved so
  // a caller without a token list still lines both sides up on the same token.
  const wantedMint = mint ?? channel?.mint;
  const onChainToken =
    wantedMint && wallet?.balances ? wallet.balances.find((b) => b.mint === wantedMint) : null;
  return {
    channel: channel?.uiAmount ?? null,
    onChain: onChainToken?.uiAmount ?? (wallet ? "0" : null),
  };
}
