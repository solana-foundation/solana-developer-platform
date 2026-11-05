"use client";
import type { Token, TokenAllowlistEntry } from "@sdp/types/tokens";
import { z } from "zod";
import { readTokenAuthorityWallets } from "@/app/(session)/dashboard/[projectId]/issuance/[tokenId]/token-authority-wallets.data";
import { issuanceQueryKeys } from "@/app/(session)/dashboard/[projectId]/issuance/issuance-query-key";
import { useTranslations } from "@/i18n/provider";
import {
  useDashboardKeyScope,
  useDashboardRead,
  useDashboardSWR,
  useInvalidateDashboardReads,
} from "@/lib/dashboard-swr";

const frozenAccountsTotalResponseSchema = z.object({
  total: z.number().int().nonnegative(),
});

function requestErrorMessage(error: Error | undefined, fallback: string): string | null {
  if (error === undefined) return null;
  return error.message === "" ? fallback : error.message;
}

export function useTokenOperationData({
  token,
  shouldLoadAuthorityWallets,
}: {
  token: Token;
  shouldLoadAuthorityWallets: boolean;
}) {
  const t = useTranslations();
  const scope = useDashboardKeyScope();
  const invalidateReads = useInvalidateDashboardReads();
  const {
    data: authorityWalletsData,
    error: authorityWalletsRequestError,
    mutate: mutateAuthorityWallets,
  } = useDashboardSWR(
    shouldLoadAuthorityWallets
      ? issuanceQueryKeys.authorityWallets(scope, { tokenId: token.id })
      : null,
    readTokenAuthorityWallets,
    {
      refreshInterval: 60_000,
      revalidateOnFocus: true,
      revalidateIfStale: true,
    }
  );
  const authorityWalletsError = requestErrorMessage(
    authorityWalletsRequestError,
    t("DashboardIssuance.management.unableToLoadSignerWallets")
  );
  const authorityWalletsLoading =
    shouldLoadAuthorityWallets && authorityWalletsData === undefined && !authorityWalletsError;
  const {
    data: frozenAccountsData,
    error: frozenAccountsRequestError,
    isLoading: frozenAccountsLoading,
  } = useDashboardRead(
    token.mintAddress ? issuanceQueryKeys.frozenAccounts(scope, { tokenId: token.id }) : null,
    frozenAccountsTotalResponseSchema,
    { revalidateOnFocus: true, revalidateIfStale: true }
  );

  const revalidateAfterSuccess = async () => {
    if (shouldLoadAuthorityWallets) {
      await mutateAuthorityWallets();
    }
    // The control-list search/labels fetch lives inside ControlListEntries with
    // its own SWR keys; refresh every cached page + labels facet for this token
    // so add/remove is reflected there and in the count.
    await invalidateReads(issuanceQueryKeys.isTokenAllowlistKey(token.id));
    // TokenTransactionsBrowser owns its own paged/filtered SWR keys; refresh them
    // so a mint/burn/etc. shows up in the transactions list right away.
    await invalidateReads(issuanceQueryKeys.isTokenTransactionsKey(token.id));
    await invalidateReads(issuanceQueryKeys.isTokenFrozenAccountsKey(token.id));
  };
  const authorityWallets =
    authorityWalletsError !== null || authorityWalletsData === undefined
      ? []
      : authorityWalletsData.authorityWallets;
  // Entries are paged by ControlListEntries. Operations rely on the API for the
  // authoritative access-control check rather than a partial client snapshot.
  const allowlistEntries: TokenAllowlistEntry[] = [];

  return {
    authorityWallets,
    authorityWalletsData,
    authorityWalletsError,
    authorityWalletsLoading,
    allowlistEntries,
    frozenAccountsError: requestErrorMessage(
      frozenAccountsRequestError,
      t("DashboardIssuance.controlLists.loadError")
    ),
    frozenAccountsLoading,
    frozenAccountsTotal: frozenAccountsData?.total ?? 0,
    revalidateAfterSuccess,
  };
}
