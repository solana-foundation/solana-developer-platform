"use client";

import { SkeletonBlock } from "@sdp/ui/skeleton-block";
import {
  formatTotalBalance,
  resolveTotalBalance,
} from "@/app/(session)/dashboard/[projectId]/payments/payments-overview.utils";
import { useWalletSummaries } from "@/app/(session)/dashboard/[projectId]/payments/shared-reads";
import { useTranslations } from "@/i18n/provider";
import { useWalletBalances, WALLET_BALANCE_REFRESH } from "./custody-reads";

/**
 * A wallet's total from the one read of every wallet's balances that all the cards share. A
 * wallet the batch fails or leaves out is read on its own.
 */
export function WalletCardBalanceValue({ walletId }: { walletId: string }) {
  const t = useTranslations();
  const { data: batchWallets, error: batchError } = useWalletSummaries(
    { includeBalances: true },
    WALLET_BALANCE_REFRESH
  );
  const batchBalances = batchWallets?.find((wallet) => wallet.walletId === walletId)?.balances;
  const batchFailed =
    batchError !== undefined || (batchWallets !== undefined && batchBalances === undefined);
  const { data: ownBalances, error: ownError } = useWalletBalances(batchFailed ? walletId : null);

  const balances = batchFailed ? (ownBalances ?? batchBalances) : batchBalances;
  if (balances === undefined) {
    if (batchFailed && ownError !== undefined) {
      return <span className="font-medium text-muted">—</span>;
    }
    return <SkeletonBlock className="inline-block h-[1em] w-20 align-middle" />;
  }
  const stale = batchFailed && (ownBalances === undefined || ownError !== undefined);

  return (
    <span className={`font-medium ${stale ? "text-muted" : "text-primary"}`}>
      {formatTotalBalance(resolveTotalBalance(balances))}
      {stale ? <span className="sr-only"> {t("DashboardCustody.stale")}</span> : null}
    </span>
  );
}
