"use client";

import type { CustodyWalletSummary } from "@sdp/types";
import useSWR from "swr";

/**
 * Funding wallets for the deposit flow: the org's own SDP wallets, plus the
 * display helpers every surface that names one needs.
 *
 * An SDP wallet is the funding source, never the Earn product itself. For a
 * custodial program the operator transfers funds to the provider's address, so
 * the choice shapes instructions only. For a `vault_direct` deposit the chosen
 * custody-wallet row is sent to the API because that wallet signs the on-chain
 * deposit and holds the resulting shares. One live wallet inventory serves
 * both flows; their write contracts remain deliberately separate.
 */

/**
 * Balances come from live RPC reads, so they are opt-in per request and served
 * from short-TTL caches on both sides. They are shown as context only — never
 * as a gate on what the user may deposit.
 */
const WALLETS_PATH =
  "/api/dashboard/wallets?view=summary&includeBalances=true&includeAllProviders=true";

export async function fetchFundingWallets(): Promise<CustodyWalletSummary[]> {
  const response = await fetch(WALLETS_PATH);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  const body = (await response.json()) as unknown;
  if (
    !body ||
    typeof body !== "object" ||
    !("data" in body) ||
    !body.data ||
    typeof body.data !== "object" ||
    !("wallets" in body.data) ||
    !Array.isArray(body.data.wallets)
  ) {
    // An invalid success envelope is an upstream failure, not an empty wallet
    // list. Treating it as [] would disable deposits while claiming the org
    // simply has no wallets.
    throw new Error("Invalid custody wallet response");
  }
  // Only usable funding sources: an inactive wallet cannot originate a transfer.
  return (body.data.wallets as CustodyWalletSummary[]).filter(
    (wallet) => wallet.status === "active"
  );
}

export function useEarnFundingWallets() {
  const { data, error, isLoading, mutate } = useSWR("dashboard-earn-funding-wallets", () =>
    fetchFundingWallets()
  );
  return { wallets: data, error, isLoading, refresh: () => void mutate() };
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
