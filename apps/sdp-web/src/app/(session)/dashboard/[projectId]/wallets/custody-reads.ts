"use client";

import { CUSTODY_PROVIDERS } from "@sdp/types/custody";
import { useMemo } from "react";
import { z } from "zod";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { type IssuedTokensByMint, symbolsByMint } from "./[walletId]/wallet-detail.shared";
import { custodyQueryKeys } from "./custody-query-key";

const BALANCE_REFRESH_INTERVAL_MS = 30_000;

const walletTokenBalanceSchema = z.object({
  token: z.string(),
  mint: z.string(),
  amount: z.string(),
  uiAmount: z.string(),
  decimals: z.number(),
  usdPrice: z.number().optional(),
  usdValue: z.number().optional(),
});

const custodyWalletListItemSchema = z.object({
  walletId: z.string().min(1),
  publicKey: z.string().min(1),
  label: z.string().nullable(),
  purpose: z.string().nullable(),
  status: z.string(),
  provider: z.enum(CUSTODY_PROVIDERS).optional(),
  isRuntimeExecutionAllowed: z.boolean(),
});

export type CustodyWalletListItem = z.infer<typeof custodyWalletListItemSchema>;

const custodyWalletsResponseSchema = z.object({
  data: z.object({ wallets: z.array(custodyWalletListItemSchema) }),
});

const walletBalancesResponseSchema = z.object({
  data: z.object({
    walletBalances: z.object({ balances: z.array(walletTokenBalanceSchema) }),
  }),
});

const issuedTokenNamesResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      mintAddress: z.string().nullable(),
      name: z.string().nullable().optional(),
      symbol: z.string().nullable().optional(),
    })
  ),
});

export function useCustodyWallets() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(custodyQueryKeys.wallets(scope), custodyWalletsResponseSchema);
  return { ...response, data: response.data?.data.wallets };
}

/** One wallet's tracked balances, re-read every 30 seconds while the tab is visible. */
export function useWalletBalances(walletId: string | null) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    walletId === null ? null : custodyQueryKeys.walletBalances(scope, { walletId }),
    walletBalancesResponseSchema,
    {
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
    }
  );
  return { ...response, data: response.data?.data.walletBalances.balances };
}

/**
 * Tokens this organization issued, by mint: their names in a wallet's balances and activity.
 * Pass the Issuance flag as `enabled`: a deployment without Issuance refuses the listing.
 */
export function useIssuedTokenNames(enabled: boolean) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    enabled ? custodyQueryKeys.issuedTokenNames(scope) : null,
    issuedTokenNamesResponseSchema
  );
  const tokens = response.data?.data;
  const byMint = useMemo(() => {
    if (tokens === undefined) return undefined;
    const issued: IssuedTokensByMint = {};
    for (const token of tokens) {
      const mint = token.mintAddress?.trim();
      if (!mint) continue;
      issued[mint] = {
        id: token.id,
        name: token.name ?? null,
        symbol: token.symbol?.trim() || null,
      };
    }
    return issued;
  }, [tokens]);
  return { ...response, data: byMint };
}

/**
 * Symbols by mint for naming a wallet's amounts, from its balances and the issued tokens. A
 * source that failed names nothing, so its mints show as they are; `settled` holds the rows
 * back until both sources have answered.
 */
export function useWalletSymbols(walletId: string, issuanceEnabled: boolean) {
  const balances = useWalletBalances(walletId);
  const issued = useIssuedTokenNames(issuanceEnabled);
  const balanceRows = balances.data;
  const issuedByMint = issued.data;
  const symbols = useMemo(
    () => symbolsByMint(balanceRows ?? [], issuedByMint ?? {}),
    [balanceRows, issuedByMint]
  );
  const balancesSettled = balanceRows !== undefined || balances.error !== undefined;
  const issuedSettled =
    !issuanceEnabled || issuedByMint !== undefined || issued.error !== undefined;
  return { symbols, settled: balancesSettled && issuedSettled };
}
