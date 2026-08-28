"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocale, useTranslations } from "@/i18n/provider";
import { formatCurrencyAmount } from "@/app/dashboard/payments/payments-overview.utils";
import {
  type RingsWallet,
  type RingsWalletSync,
  syncRingsWallet,
} from "./helius-rings.data";
import { formatAssetAmount } from "./helius-rings.utils";

type BalancesState =
  | { name: "loading" }
  | { name: "observed"; sync: RingsWalletSync }
  | { name: "failed" };

/**
 * Wallet header + full balance summary for the selected wallet. This is the
 * one place with a manual refresh button — the wallets table just displays
 * the total and follows the workspace's completion signal.
 */
export function WalletOverview({
  wallet,
  refreshTick,
}: {
  wallet: RingsWallet;
  refreshTick?: number;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [state, setState] = useState<BalancesState>({ name: "loading" });
  const [manualTick, setManualTick] = useState(0);

  useEffect(() => {
    if (wallet.shieldedAddress === null) return;
    let cancelled = false;
    setState({ name: "loading" });
    void (async () => {
      try {
        const result = await syncRingsWallet(wallet.id);
        if (cancelled) return;
        setState(result.sync ? { name: "observed", sync: result.sync } : { name: "failed" });
      } catch {
        if (!cancelled) setState({ name: "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wallet.id, wallet.shieldedAddress, refreshTick, manualTick]);

  const reading = state.name === "loading";
  const refreshLabel = t(
    reading ? "DashboardHeliusRings.balances.refreshing" : "DashboardHeliusRings.balances.refresh"
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{wallet.name}</CardTitle>
        <CardAction>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={reading || wallet.shieldedAddress === null}
            aria-label={refreshLabel}
            title={refreshLabel}
            onClick={() => setManualTick((current) => current + 1)}
          >
            {reading ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw aria-hidden="true" />
            )}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <hr className="border-border-default" role="presentation" />
        <p className="text-xs font-medium uppercase tracking-wide text-tertiary">
          {t("DashboardHeliusRings.overview.privateBalanceLabel")}
        </p>
        {wallet.shieldedAddress === null ? (
          <p className="text-secondary">{t("DashboardHeliusRings.overview.notProvisioned")}</p>
        ) : state.name === "loading" ? (
          <p className="text-secondary">{t("DashboardHeliusRings.overview.loading")}</p>
        ) : state.name === "failed" ? (
          <p className="text-error">{t("DashboardHeliusRings.overview.failed")}</p>
        ) : (
          <Summary sync={state.sync} locale={locale} />
        )}
      </CardContent>
    </Card>
  );
}

function Summary({ sync, locale }: { sync: RingsWalletSync; locale: string }) {
  const t = useTranslations();

  if (sync.balances.length === 0) {
    return (
      <p className="text-2xl font-semibold tabular-nums text-primary">
        {formatCurrencyAmount(0, locale)}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {typeof sync.totalUsd === "number" ? (
        <p className="text-2xl font-semibold tabular-nums text-primary">
          {formatCurrencyAmount(sync.totalUsd, locale)}
        </p>
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {sync.balances.map((balance) => (
          <li
            key={balance.mint}
            className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm"
          >
            <span className="tabular-nums text-primary">
              {formatAssetAmount(balance.amountRaw, balance.mint)}
            </span>
            <span className="tabular-nums text-secondary">
              {typeof balance.usdValue === "number"
                ? formatCurrencyAmount(balance.usdValue, locale)
                : t("DashboardHeliusRings.overview.unpriced")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
