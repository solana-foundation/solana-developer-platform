"use client";

import { formatCurrencyAmount } from "@/app/dashboard/payments/payments-overview.utils";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { RingsWallet } from "./helius-rings.data";
import { useRingsBalance } from "./use-rings-balance";

/**
 * One wallet's shielded balance in the wallets table. Auto-syncs on mount and
 * whenever the workspace signals a completed operation; there's no refresh
 * button here — that lives on the Wallet Overview above the composer.
 */
export function ShieldedBalanceCard({
  wallet,
  refreshTick,
}: {
  wallet: RingsWallet;
  refreshTick?: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { state } = useRingsBalance(
    wallet.shieldedAddress === null ? null : wallet.id,
    refreshTick
  );

  if (wallet.shieldedAddress === null) {
    return (
      <p className="text-pretty break-words text-sm text-secondary">
        {t("DashboardHeliusRings.balances.notProvisioned")}
      </p>
    );
  }

  if (state.name === "failed") {
    return (
      <p className="text-pretty break-words text-xs text-error" role="alert">
        {state.message ?? t("DashboardHeliusRings.balances.readFailed")}
      </p>
    );
  }

  if (state.name === "loading") {
    return <p className="text-sm text-secondary">{t("DashboardHeliusRings.balances.unsynced")}</p>;
  }

  const { sync } = state;
  return sync.balances.length === 0 ? (
    <p className="text-sm text-primary">{t("DashboardHeliusRings.balances.empty")}</p>
  ) : (
    <p className="text-sm font-medium tabular-nums text-primary">
      {typeof sync.totalUsd === "number"
        ? formatCurrencyAmount(sync.totalUsd, locale)
        : t("DashboardHeliusRings.overview.unpriced")}
    </p>
  );
}
