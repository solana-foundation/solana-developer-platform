"use client";

import type { CustodyWalletSummary, CustodyWalletTokenBalance } from "@sdp/types";
import useSWR from "swr";
import { portfolioTokenForMint } from "../earn-program-presentation";

/**
 * Funding wallets for the deposit flow: the org's own SDP wallets, plus the
 * display helpers every surface that names one needs.
 *
 * Earn's program wallets are provisioned and custodied by the provider (Ground),
 * so an SDP wallet is never a program itself — it is where the stablecoins are
 * sent FROM. The selection is deliberately NOT persisted: neither
 * `POST /v1/earn/programs` nor `PUT /v1/earn/programs/:programId` has a
 * source-wallet field and no API moves funds from an SDP wallet into a
 * program, so recording it would only look like state that means something.
 * Funding is a transfer the operator makes to the provider's Solana address; the
 * choice here shapes the instructions for that, and nothing else.
 */

/**
 * The one custody provider the deposit flow offers to connect. Note what this
 * is NOT: SDP's Fireblocks setup uses the platform's own Fireblocks credentials
 * and provisions a vault account for the scope — pasting an organization's own
 * API keys or adopting an existing vault account is not a supported operation
 * anywhere in the API.
 */
export const EARN_CONNECT_WALLET_PROVIDER = "fireblocks" as const;

/** Deep link into wallet setup, pre-pointed at the provider (skips its step 1). */
export const EARN_CONNECT_WALLET_HREF = `/dashboard/wallets/setup?provider=${EARN_CONNECT_WALLET_PROVIDER}`;

/**
 * Balances come from live RPC reads, so they are opt-in per request and served
 * from short-TTL caches on both sides. They are shown as context only — never
 * as a gate on what the user may deposit.
 */
const WALLETS_PATH =
  "/api/dashboard/wallets?view=summary&includeBalances=true&includeAllProviders=true";

async function fetchFundingWallets(): Promise<CustodyWalletSummary[]> {
  const response = await fetch(WALLETS_PATH);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const body = (await response.json()) as { data?: { wallets?: CustodyWalletSummary[] } };
  // Only usable funding sources: an inactive wallet cannot originate a transfer.
  return (body.data?.wallets ?? []).filter((wallet) => wallet.status === "active");
}

export function useEarnFundingWallets() {
  const { data, error, isLoading } = useSWR("dashboard-earn-funding-wallets", () =>
    fetchFundingWallets()
  );
  return { wallets: data, error, isLoading };
}

// --- Display helpers -------------------------------------------------------

/**
 * What to call a wallet on screen. THE single source for this: a wallet label is
 * user-set and nullable, and `||` (not `??`) is required so a label of spaces
 * falls back instead of rendering an empty name.
 */
export function walletDisplayName(
  wallet: CustodyWalletSummary | undefined,
  fallback: string
): string {
  return wallet?.label?.trim() || fallback;
}

/**
 * Stablecoin holdings worth naming on a wallet row, largest first. Uses the
 * token `uiAmount` rather than `usdValue`: the USD figure is optional on a
 * balance row, and rendering an absent one as "$0.00" would understate a funded
 * wallet.
 */
export function walletStablecoinHoldings(
  wallet: CustodyWalletSummary
): readonly CustodyWalletTokenBalance[] {
  const holdings = (wallet.balances ?? []).filter((balance) => {
    if (portfolioTokenForMint(balance.mint) === undefined) return false;
    const amount = Number(balance.uiAmount);
    return Number.isFinite(amount) && amount > 0;
  });
  return [...holdings].sort((left, right) => Number(right.uiAmount) - Number(left.uiAmount));
}

/**
 * Shortened address for dense rows; never monospaced (SDP typography rule).
 * Module-local on purpose: payments and issuance each keep their own with
 * different lead/tail for their own density, and importing either would couple
 * Earn to an unrelated module's utils.
 */
export function shortenAddress(address: string): string {
  return address.length <= 16 ? address : `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/**
 * Client-side wallet search over the fields a row actually shows. Mirrors the
 * custody module's own filter so the two lists behave alike.
 */
export function matchesWalletQuery(wallet: CustodyWalletSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [wallet.label, wallet.publicKey, wallet.provider, wallet.purpose].some(
    (field) => typeof field === "string" && field.toLowerCase().includes(needle)
  );
}
