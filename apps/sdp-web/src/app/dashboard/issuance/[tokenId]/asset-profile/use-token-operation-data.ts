"use client";
import type { Token, TokenAllowlistEntry } from "@sdp/types";
import { useSWRConfig } from "swr";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { issuanceQueryKeys } from "../../issuance-query-key";
import { fetchTokenAuthorityWallets } from "../token-authority-wallets.data";
import { isTokenAllowlistKey } from "./allowlist-cache";
import { fetchFrozenAccountsTotal } from "./frozen-accounts.data";
import { isTokenTransactionsKey } from "./transactions-cache";

// Shared cache keys and TTLs keep operational data coherent after mutations.
const TOKEN_AUTHORITY_WALLETS_CACHE_TTL_MS = 60_000;
const TOKEN_FROZEN_ACCOUNTS_KEY = "token-frozen-accounts";

function isTokenFrozenAccountsKey(key: unknown, tokenId: string): boolean {
  return Array.isArray(key) && key[0] === TOKEN_FROZEN_ACCOUNTS_KEY && key[1] === tokenId;
}

function requestErrorMessage(error: unknown, fallback: string): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : fallback;
}

export function useTokenOperationData({
  token,
  shouldLoadAuthorityWallets,
}: {
  token: Token;
  shouldLoadAuthorityWallets: boolean;
}) {
  const t = useTranslations();
  const { mutate: globalMutate } = useSWRConfig();
  const {
    data: authorityWalletsData,
    error: authorityWalletsRequestError,
    mutate: mutateAuthorityWallets,
  } = usePersistedDashboardSWR(
    shouldLoadAuthorityWallets ? issuanceQueryKeys.authorityWallets({ tokenId: token.id }) : null,
    ([, tokenId]: readonly [string, string]) => fetchTokenAuthorityWallets(tokenId, t),
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateIfStale: true,
    },
    {
      key: `token.${token.id}.authority-wallets`,
      ttlMs: TOKEN_AUTHORITY_WALLETS_CACHE_TTL_MS,
    }
  );
  const authorityWalletsFetchError = requestErrorMessage(
    authorityWalletsRequestError,
    t("DashboardIssuance.management.unableToLoadSignerWallets")
  );
  const authorityWalletsLoading =
    shouldLoadAuthorityWallets && authorityWalletsData === undefined && !authorityWalletsFetchError;
  const {
    data: frozenAccountsTotal,
    error: frozenAccountsRequestError,
    isLoading: frozenAccountsLoading,
  } = usePersistedDashboardSWR(
    token.mintAddress ? ([TOKEN_FROZEN_ACCOUNTS_KEY, token.id] as const) : null,
    ([, tokenId]: readonly [string, string]) => fetchFrozenAccountsTotal(tokenId),
    { revalidateOnFocus: true, revalidateIfStale: true },
    { key: `token.${token.id}.frozen-accounts`, ttlMs: 30_000 }
  );

  const revalidateAfterSuccess = async () => {
    if (shouldLoadAuthorityWallets) {
      await mutateAuthorityWallets();
    }
    // The control-list search/labels fetch lives inside ControlListEntries with
    // its own SWR keys; refresh every cached page + labels facet for this token
    // so add/remove is reflected there and in the count.
    await globalMutate((key) => isTokenAllowlistKey(key, token.id));
    // TokenTransactionsBrowser owns its own paged/filtered SWR keys; refresh them
    // so a mint/burn/etc. shows up in the transactions list right away.
    await globalMutate((key) => isTokenTransactionsKey(key, token.id));
    await globalMutate((key) => isTokenFrozenAccountsKey(key, token.id));
  };
  const authorityWalletsError =
    authorityWalletsFetchError ?? authorityWalletsData?.authorityWalletsError ?? null;
  const authorityWallets = authorityWalletsError
    ? []
    : (authorityWalletsData?.authorityWallets ?? []);
  // Entries are paged by ControlListEntries. Operations rely on the API for the
  // authoritative access-control check rather than a partial client snapshot.
  const allowlistEntries: TokenAllowlistEntry[] = [];

  return {
    authorityWallets,
    authorityWalletsData,
    authorityWalletsFetchError,
    authorityWalletsError,
    authorityWalletsLoading,
    allowlistEntries,
    frozenAccountsError: requestErrorMessage(
      frozenAccountsRequestError,
      t("DashboardIssuance.controlLists.loadError")
    ),
    frozenAccountsLoading,
    frozenAccountsTotal: frozenAccountsTotal ?? 0,
    revalidateAfterSuccess,
  };
}
