"use client";

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { useWalletSummaries } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useTranslations } from "@/i18n/provider";

/** The Project's wallets with live balances, for the payment flows' wallet pickers. */
export function usePaymentsActionWallets(): {
  liveWallets: PaymentsDashboardWallet[];
  walletsLoading: boolean;
  liveWalletsError: string | null;
  retryWallets: () => void;
} {
  const t = useTranslations();
  const { data, error, mutate } = useWalletSummaries({ includeBalances: true });
  return {
    liveWallets: data ?? [],
    walletsLoading: data === undefined && error === undefined,
    liveWalletsError:
      error === undefined
        ? null
        : t("DashboardPayments.page.walletApiError", {
            status: error.status,
            error: error.code ?? t("DashboardPayments.page.unknownError"),
          }),
    retryWallets: () => void mutate(),
  };
}
