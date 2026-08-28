"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatCurrencyAmount } from "@/app/dashboard/payments/payments-overview.utils";
import { type RingsWallet, type RingsWalletSync, syncRingsWallet } from "./helius-rings.data";

type Observation =
  | { name: "unsynced" }
  | { name: "observed"; sync: RingsWalletSync }
  | { name: "failed"; message: string };

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

  const [observation, setObservation] = useState<Observation>({ name: "unsynced" });
  const [reading, setReading] = useState(false);

  const provisioned = wallet.shieldedAddress !== null;

  const handleRefresh = useCallback(async () => {
    setReading(true);
    try {
      const result = await syncRingsWallet(wallet.id);
      setObservation(
        result.sync
          ? { name: "observed", sync: result.sync }
          : {
              name: "failed",
              message: result.error ?? t("DashboardHeliusRings.balances.readFailed"),
            }
      );
    } catch {
      setObservation({ name: "failed", message: t("DashboardHeliusRings.balances.readFailed") });
    } finally {
      setReading(false);
    }
  }, [wallet.id, t]);

  useEffect(() => {
    if (!provisioned) return;
    void handleRefresh();
  }, [provisioned, handleRefresh, refreshTick]);

  if (!provisioned) {
    return (
      <p className="text-pretty break-words text-sm text-secondary">
        {t("DashboardHeliusRings.balances.notProvisioned")}
      </p>
    );
  }

  if (observation.name === "failed") {
    return (
      <p className="text-pretty break-words text-xs text-error" role="alert">
        {observation.message}
      </p>
    );
  }

  if (observation.name === "unsynced" || reading) {
    return <p className="text-sm text-secondary">{t("DashboardHeliusRings.balances.unsynced")}</p>;
  }

  const { sync } = observation;
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
