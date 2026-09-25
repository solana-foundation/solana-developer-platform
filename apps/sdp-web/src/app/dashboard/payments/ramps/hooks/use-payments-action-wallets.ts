"use client";

import type { PaymentsDashboardWallet } from "@sdp/types";
import { paymentsQueryKeys } from "@/app/dashboard/payments/payments-query-key";
import { fetchWallets } from "@/app/dashboard/payments/payments-workspace.data";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { usePersistedDashboardSWR } from "@/lib/dashboard-swr";

/**
 * Loads payment action wallets with live balances while preserving the initial server wallet state.
 *
 * The SWR entry and the BFF request are bound to the workspace's rendered
 * project instead of the shared selection cookie, so a sibling tab switching
 * the cookie cannot replace this workspace's wallet inventory and balances
 * with another (accessible) project's during a revalidation.
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
  const { selectedProjectId } = useDashboardWorkspace();
  const { data: swrWallets, error: walletsFetchError } = usePersistedDashboardSWR<
    PaymentsDashboardWallet[]
  >(
    selectedProjectId ? paymentsQueryKeys.actionWallets({ projectId: selectedProjectId }) : null,
    selectedProjectId
      ? () => fetchWallets({ includeBalances: true, projectId: selectedProjectId }, t)
      : null,
    {
      fallbackData: wallets.length > 0 ? wallets : undefined,
    }
  );
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
