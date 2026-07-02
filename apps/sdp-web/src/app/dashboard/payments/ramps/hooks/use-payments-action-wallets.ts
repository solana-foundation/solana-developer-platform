"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { fetchWallets } from "@/app/dashboard/payments/payments-workspace.data";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";

export const PAYMENTS_ACTION_WALLETS_KEY = "payments-action-wallets";

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
  const { data: swrWallets, error: walletsFetchError } = usePersistedDashboardSWR<
    PaymentsDashboardWallet[]
  >(PAYMENTS_ACTION_WALLETS_KEY, () => fetchWallets({ includeBalances: true }), {
    fallbackData: wallets.length > 0 ? wallets : undefined,
  });
  const liveWallets = swrWallets ?? wallets;
  const walletsLoading = swrWallets === undefined && !walletsFetchError;
  const liveWalletsError = walletsFetchError
    ? walletsFetchError instanceof Error
      ? walletsFetchError.message
      : "Request failed."
    : swrWallets === undefined
      ? walletsError
      : null;

  return {
    liveWallets,
    walletsLoading,
    liveWalletsError,
  };
}
