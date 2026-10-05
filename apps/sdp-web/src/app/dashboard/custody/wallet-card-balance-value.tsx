"use client";

import type { CustodyWalletTokenBalance } from "@sdp/types";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";
import { formatCurrencyAmount, resolveTotalBalance } from "../payments/payments-overview.utils";
import { custodyQueryKeys } from "./custody-query-key";
import {
  BALANCE_REFRESH_INTERVAL_MS,
  fetchWalletBalance,
  fetchWalletBalances,
} from "./wallet-balances.data";

const WALLET_BALANCE_CACHE_TTL_MS = 30_000;

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
  return usePersistedDashboardSWR<Record<string, CustodyWalletTokenBalance[]>>(
    enabled ? custodyQueryKeys.walletCardBalances() : null,
    fetchWalletBalances,
    {
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    },
    {
      key: "wallet-card-balances",
      ttlMs: WALLET_BALANCE_CACHE_TTL_MS,
      version: 2,
    }
  );
}

export function WalletCardBalanceValue({ walletId, initialBalances }: WalletCardBalanceValueProps) {
  const t = useTranslations();
  const { data: batchBalances, error: batchError } = useWalletCardBalances(Boolean(walletId));
  const batchFailed =
    Boolean(batchError) || (batchBalances !== undefined && batchBalances[walletId] === undefined);
  const { data: fallbackBalances, error: fallbackError } = usePersistedDashboardSWR<
    CustodyWalletTokenBalance[]
  >(
    batchFailed && walletId ? custodyQueryKeys.walletCardBalanceFallback({ walletId }) : null,
    () => fetchWalletBalance(walletId),
    {
      revalidateOnFocus: true,
      refreshWhenHidden: false,
      refreshInterval: BALANCE_REFRESH_INTERVAL_MS,
      dedupingInterval: 5_000,
      keepPreviousData: true,
    },
    {
      key: `wallet-card-balance-fallback.${walletId}`,
      ttlMs: WALLET_BALANCE_CACHE_TTL_MS,
    }
  );

  const balances = batchFailed
    ? (fallbackBalances ?? batchBalances?.[walletId] ?? initialBalances)
    : (batchBalances?.[walletId] ?? initialBalances);
  const hasError = batchFailed && (fallbackBalances === undefined || Boolean(fallbackError));
  const totalBalance = resolveTotalBalance(balances);

  return (
    <span className={`font-medium ${hasError ? "text-muted" : "text-primary"}`}>
      {formatCurrencyAmount(totalBalance)}
      {hasError ? <span className="sr-only"> {t("DashboardCustody.stale")}</span> : null}
    </span>
  );
}
