"use client";

import {
  type CustodyConfigSummary,
  custodyConfigSummarySchema,
  custodyWalletMetadataSchema,
  custodyWalletSummarySchema,
  custodyWalletTokenBalanceSchema,
} from "@sdp/types/custody";
import { useMemo } from "react";
import { z } from "zod";
import { useIssuedTokens } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useDashboardKeyScope, useDashboardRead } from "@/lib/dashboard-swr";
import { type IssuedTokensByMint, symbolsByMint } from "./[walletId]/wallet-detail.shared";
import { custodyQueryKeys } from "./custody-query-key";
import { isKnownCustodyProvider, type KnownCustodyProvider } from "./provider-catalog";

const BALANCE_REFRESH_INTERVAL_MS = 30_000;

/** The cards' and the wallet page's balance cadence: every 30s while the tab is visible. */
export const WALLET_BALANCE_REFRESH = {
  revalidateOnFocus: true,
  refreshWhenHidden: false,
  refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
} as const;

const custodyWalletsResponseSchema = z.object({
  data: z.object({ wallets: z.array(custodyWalletSummarySchema) }),
});

const custodyConfigsResponseSchema = z.object({
  data: z.object({ configs: z.array(custodyConfigSummarySchema) }),
});

const walletRecordResponseSchema = z.object({
  data: z.object({
    wallet: custodyWalletMetadataSchema,
    connection: z.object({ label: z.string(), href: z.string().nullable() }).nullable(),
  }),
});

const walletBalancesResponseSchema = z.object({
  data: z.object({
    walletBalances: z.object({ balances: z.array(custodyWalletTokenBalanceSchema) }),
  }),
});

export function useCustodyWallets() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(custodyQueryKeys.wallets(scope), custodyWalletsResponseSchema);
  return { ...response, data: response.data?.data.wallets };
}

/** The providers with an active config that the catalogue knows. */
function activeKnownProviders(configs: readonly CustodyConfigSummary[]): KnownCustodyProvider[] {
  return configs
    .filter((config) => config.status === "active")
    .map((config) => config.provider)
    .filter(isKnownCustodyProvider);
}

export function useConnectedCustodyProviders() {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(custodyQueryKeys.configs(scope), custodyConfigsResponseSchema);
  const configs = response.data?.data.configs;
  const providers = useMemo(
    () => (configs === undefined ? undefined : activeKnownProviders(configs)),
    [configs]
  );
  return { ...response, data: providers };
}

/** One wallet's record and the connection it signs through, as its page heads with them. */
export function useWalletRecord(walletId: string) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    custodyQueryKeys.wallet(scope, { walletId }),
    walletRecordResponseSchema
  );
  return { ...response, data: response.data?.data };
}

/** One wallet's tracked balances. */
export function useWalletBalances(walletId: string | null) {
  const scope = useDashboardKeyScope();
  const response = useDashboardRead(
    walletId === null ? null : custodyQueryKeys.walletBalances(scope, { walletId }),
    walletBalancesResponseSchema,
    WALLET_BALANCE_REFRESH
  );
  return { ...response, data: response.data?.data.walletBalances.balances };
}

/**
 * Tokens this organization issued, by mint: their names in a wallet's balances and activity.
 * Pass the Issuance flag as `enabled`: a deployment without Issuance refuses the listing.
 */
export function useIssuedTokensByMint(enabled: boolean) {
  const response = useIssuedTokens(enabled);
  const tokens = response.data;
  const byMint = useMemo(() => {
    if (tokens === undefined) return undefined;
    const issued: IssuedTokensByMint = {};
    for (const token of tokens) {
      if (token.id === null) continue;
      issued[token.mintAddress] = {
        id: token.id,
        name: token.name,
        symbol: token.symbol.trim() || null,
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
  const issued = useIssuedTokensByMint(issuanceEnabled);
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
