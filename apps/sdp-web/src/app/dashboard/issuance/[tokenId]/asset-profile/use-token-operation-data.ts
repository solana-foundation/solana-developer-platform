"use client";
import type { PaymentsDashboardWallet, Token } from "@sdp/types";
import { useSWRConfig } from "swr";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import {
  fetchTokenAuthorityWallets,
  fetchTokenManagementSupportingData,
  type TokenManagementSupportingData,
} from "../token-management-workspace.data";
import { fetchTokenAllowlistLabels } from "./allowlist.data";
import { isTokenAllowlistKey, TOKEN_ALLOWLIST_LABELS_KEY } from "./allowlist-cache";
import { isTokenTransactionsKey } from "./transactions-cache";

// Same cache keys and TTLs as the old TokenManagementWorkspace, so the two UIs
// share warm caches for a given token.
const TOKEN_AUTHORITY_WALLETS_CACHE_TTL_MS = 60_000;
const TOKEN_SUPPORTING_DATA_CACHE_TTL_MS = 60_000;
const TOKEN_ALLOWLIST_LABELS_CACHE_TTL_MS = 30_000;

const EMPTY_SUPPORTING_DATA: TokenManagementSupportingData = {
  authorityWallets: [],
  authorityWalletsError: null,
  transactions: [],
  transactionsError: null,
  transactionsTotal: null,
  transactionsHasMore: false,
  allowlistEntries: [],
  allowlistError: null,
  allowlistTotal: null,
  allowlistHasMore: false,
  frozenAccounts: [],
  frozenAccountsError: null,
  frozenAccountsTotal: null,
  frozenAccountsHasMore: false,
};

function mergeWalletsPreferBalances(
  primaryWallets: PaymentsDashboardWallet[],
  secondaryWallets: PaymentsDashboardWallet[]
): PaymentsDashboardWallet[] {
  if (primaryWallets.length === 0) {
    return secondaryWallets;
  }
  if (secondaryWallets.length === 0) {
    return primaryWallets;
  }

  const secondaryById = new Map(secondaryWallets.map((wallet) => [wallet.id, wallet]));
  const merged = primaryWallets.map((wallet) => {
    const richerWallet = secondaryById.get(wallet.id);
    if (!richerWallet) {
      return wallet;
    }
    return Array.isArray(richerWallet.balances)
      ? { ...wallet, balances: richerWallet.balances }
      : wallet;
  });

  const primaryIds = new Set(primaryWallets.map((wallet) => wallet.id));
  for (const wallet of secondaryWallets) {
    if (!primaryIds.has(wallet.id)) {
      merged.push(wallet);
    }
  }
  return merged;
}

function requestErrorMessage(error: unknown, fallback: string): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : fallback;
}

function useTokenControlListCount(tokenId: string, enabled: boolean) {
  const t = useTranslations();
  // Distinct labels + unfiltered entry count for the control list. Same SWR key
  // ControlListEntries uses, so its dropdown fetch is deduped; here it feeds the
  // compliance tab's summary count without touching supporting-data.
  const { data: allowlistLabelsData, error: allowlistLabelsRequestError } =
    usePersistedDashboardSWR(
      enabled ? [TOKEN_ALLOWLIST_LABELS_KEY, tokenId] : null,
      ([, tokenId]: readonly [string, string]) => fetchTokenAllowlistLabels(tokenId),
      { revalidateOnFocus: true, revalidateIfStale: true },
      { key: `token.${tokenId}.allowlist-labels`, ttlMs: TOKEN_ALLOWLIST_LABELS_CACHE_TTL_MS }
    );

  const allowlistError = requestErrorMessage(
    allowlistLabelsRequestError,
    t("DashboardIssuance.management.unableToLoadData")
  );
  const allowlistTotal = allowlistLabelsData?.total ?? null;

  return { allowlistError, allowlistTotal };
}

export function useTokenOperationData({
  token,
  shouldLoadAuthorityWallets,
  shouldLoadSupportingData,
  showControlList,
}: {
  token: Token;
  shouldLoadAuthorityWallets: boolean;
  shouldLoadSupportingData: boolean;
  showControlList: boolean;
}) {
  const t = useTranslations();
  const { mutate: globalMutate } = useSWRConfig();
  const {
    data: authorityWalletsData,
    error: authorityWalletsRequestError,
    mutate: mutateAuthorityWallets,
  } = usePersistedDashboardSWR(
    shouldLoadAuthorityWallets ? ["token-management-authority-wallets", token.id] : null,
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
  const {
    data: supportingData,
    error: supportingDataRequestError,
    mutate: mutateSupportingData,
  } = usePersistedDashboardSWR(
    shouldLoadSupportingData ? ["token-management-supporting-data", token.id] : null,
    // Skip the allowlist and transactions here — the control list is owned by
    // ControlListEntries (paged/search), transactions by TokenTransactionsBrowser
    // (paged/filtered), and the allowlist count comes from the labels endpoint below.
    ([, tokenId]: readonly [string, string]) =>
      fetchTokenManagementSupportingData(tokenId, t, {
        includeAllowlist: false,
        includeTransactions: false,
      }),
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateIfStale: true,
    },
    {
      key: `token.${token.id}.supporting-data`,
      ttlMs: TOKEN_SUPPORTING_DATA_CACHE_TTL_MS,
    }
  );

  const { allowlistError, allowlistTotal } = useTokenControlListCount(token.id, showControlList);

  const supportingDataError = requestErrorMessage(
    supportingDataRequestError,
    t("DashboardIssuance.management.unableToLoadData")
  );
  const supportingDataLoading =
    shouldLoadSupportingData && supportingData === undefined && !supportingDataError;
  const resolvedSupportingData = supportingData ?? EMPTY_SUPPORTING_DATA;
  const authorityWalletsFetchError = requestErrorMessage(
    authorityWalletsRequestError,
    t("DashboardIssuance.management.unableToLoadSignerWallets")
  );
  const authorityWalletsLoading =
    shouldLoadAuthorityWallets && authorityWalletsData === undefined && !authorityWalletsFetchError;

  const revalidateAfterSuccess = async () => {
    if (shouldLoadAuthorityWallets) {
      await mutateAuthorityWallets();
    }
    if (shouldLoadSupportingData) {
      await mutateSupportingData();
    }
    // The control-list search/labels fetch lives inside ControlListEntries with
    // its own SWR keys; refresh every cached page + labels facet for this token
    // so add/remove is reflected there and in the count.
    await globalMutate((key) => isTokenAllowlistKey(key, token.id));
    // TokenTransactionsBrowser owns its own paged/filtered SWR keys; refresh them
    // so a mint/burn/etc. shows up in the transactions list right away.
    await globalMutate((key) => isTokenTransactionsKey(key, token.id));
  };
  const authorityWallets = mergeWalletsPreferBalances(
    authorityWalletsData?.authorityWallets ?? [],
    resolvedSupportingData.authorityWallets
  );
  const authorityWalletsError =
    authorityWalletsFetchError ??
    authorityWalletsData?.authorityWalletsError ??
    supportingDataError ??
    resolvedSupportingData.authorityWalletsError;
  const transactions = resolvedSupportingData.transactions;
  const transactionsError = supportingDataError ?? resolvedSupportingData.transactionsError;
  const transactionsTotal = resolvedSupportingData.transactionsTotal;
  const transactionsHasMore = resolvedSupportingData.transactionsHasMore;
  // The control list is served by ControlListEntries (paged/search); asset-profile
  // no longer pulls entries through supporting-data. Count + error come from the
  // labels fetch above.
  const allowlistEntries = resolvedSupportingData.allowlistEntries;
  const allowlistHasMore = false;
  const frozenAccounts = resolvedSupportingData.frozenAccounts;
  const frozenAccountsError = supportingDataError ?? resolvedSupportingData.frozenAccountsError;
  const frozenAccountsTotal = resolvedSupportingData.frozenAccountsTotal;
  const frozenAccountsHasMore = resolvedSupportingData.frozenAccountsHasMore;

  return {
    authorityWallets,
    authorityWalletsError,
    authorityWalletsLoading,
    supportingDataLoading,
    transactions,
    transactionsError,
    transactionsTotal,
    transactionsHasMore,
    allowlistEntries,
    allowlistError,
    allowlistTotal,
    allowlistHasMore,
    frozenAccounts,
    frozenAccountsError,
    frozenAccountsTotal,
    frozenAccountsHasMore,
    revalidateAfterSuccess,
  };
}
