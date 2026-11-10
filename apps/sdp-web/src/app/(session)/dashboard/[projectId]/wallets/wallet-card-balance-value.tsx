"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types/custody";
import useSWR from "swr";
import {
  formatTotalBalance,
  resolveTotalBalance,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import { useTranslations } from "@/i18n/provider";
import { custodyQueryKeys } from "./custody-query-key";
import {
  BALANCE_REFRESH_INTERVAL_MS,
  fetchWalletBalance,
  fetchWalletBalances,
} from "./wallet-balances.data";

interface WalletCardBalanceValueProps {
  walletId: string;
  initialBalances: CustodyWalletTokenBalance[];
}

/**
 * Every wallet's balances in one request, refreshed every 30 seconds. SWR shares the one read
 * between the cards and the Wallets page's refresh control, which calls `mutate` to re-read now;
 * an airdrop refreshes it through `custodyQueryKeys.isWalletLiveDataKey`.
 */
export function useWalletCardBalances(enabled = true) {
  return useSWR<Record<string, CustodyWalletTokenBalance[]>>(
    enabled ? custodyQueryKeys.walletCardBalances() : null,
    fetchWalletBalances,
    {
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    }
  );
}

export function WalletCardBalanceValue({ walletId, initialBalances }: WalletCardBalanceValueProps) {
  const t = useTranslations();
  const { data: batchBalances, error: batchError } = useWalletCardBalances(Boolean(walletId));
  const batchFailed =
    Boolean(batchError) || (batchBalances !== undefined && batchBalances[walletId] === undefined);
  const { data: fallbackBalances, error: fallbackError } = useSWR<CustodyWalletTokenBalance[]>(
    batchFailed && walletId ? custodyQueryKeys.walletCardBalanceFallback({ walletId }) : null,
    () => fetchWalletBalance(walletId),
    {
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    }
  );

  const balances = batchFailed
    ? (fallbackBalances ?? batchBalances?.[walletId] ?? initialBalances)
    : (batchBalances?.[walletId] ?? initialBalances);
  const hasError = batchFailed && (fallbackBalances === undefined || Boolean(fallbackError));
  const totalBalance = resolveTotalBalance(balances);

  return (
    <span className={`font-medium ${hasError ? "text-muted" : "text-primary"}`}>
      {formatTotalBalance(totalBalance)}
      {hasError ? <span className="sr-only"> {t("DashboardCustody.stale")}</span> : null}
    </span>
  );
}
