"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { fetchWallets } from "@/app/dashboard/payments/payments-workspace.data";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";

/**
 * Loads payment action wallets with live balances while preserving the initial server wallet state.
 */
export function usePaymentsActionWallets(
  wallets: PaymentsDashboardWallet[],
  walletsError: string | null
): {
  liveWallets: PaymentsDashboardWallet[];
  walletsLoading: boolean;
  liveWalletsError: string | null;
} {
  const t = useTranslations();
  const { data: swrWallets, error: walletsFetchError } = usePersistedDashboardSWR<
    PaymentsDashboardWallet[]
  >(paymentsQueryKeys.actionWallets(), () => fetchWallets({ includeBalances: true }, t), {
    fallbackData: wallets.length > 0 ? wallets : undefined,
  });
  const liveWallets = swrWallets ?? wallets;
  const walletsLoading = swrWallets === undefined && !walletsFetchError;
  const liveWalletsError = walletsFetchError
    ? walletsFetchError instanceof Error
      ? walletsFetchError.message
      : t("DashboardPayments.requestFailed")
    : swrWallets === undefined
      ? walletsError
      : null;

  return {
    liveWallets,
    walletsLoading,
    liveWalletsError,
  };
}
