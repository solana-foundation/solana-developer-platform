"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { formatCurrencyAmount } from "@/app/dashboard/payments/payments-overview.utils";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useLocale, useTranslations } from "@/i18n/provider";
import type { ProjectRing, RingsWallet, RingsWalletSync } from "./helius-rings.data";
import {
  formatAssetAmount,
  ringNameByProgramId,
  shortenShieldedAddress,
} from "./helius-rings.utils";
import { useRingsBalance } from "./use-rings-balance";

/**
 * Adjacent-run grouping over the API's deterministic order (default bucket
 * first, then rings ascending) — value never merges across rings, so each
 * ring's notes read as their own block. No client-side re-sort.
 */
function groupByRing(
  balances: RingsWalletSync["balances"]
): Array<{ ring: string | null; balances: RingsWalletSync["balances"] }> {
  const groups: Array<{ ring: string | null; balances: RingsWalletSync["balances"] }> = [];
  for (const balance of balances) {
    const current = groups[groups.length - 1];
    if (current && current.ring === balance.ringProgramId) {
      current.balances.push(balance);
    } else {
      groups.push({ ring: balance.ringProgramId, balances: [balance] });
    }
  }
  return groups;
}

/**
 * Wallet header + full balance summary for the selected wallet. This is the
 * one place with a manual refresh button — the wallets table just displays
 * the total and follows the workspace's completion signal.
 */
export function WalletOverview({
  wallet,
  refreshTick,
  projectRings,
}: {
  wallet: RingsWallet;
  refreshTick?: number;
  /** Names the per-ring balance groups; unknown ids fall back to the truncated program id. */
  projectRings: ProjectRing[];
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { state, refresh } = useRingsBalance(
    wallet.shieldedAddress === null ? null : wallet.id,
    refreshTick
  );

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
            onClick={refresh}
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
          <Summary sync={state.sync} locale={locale} projectRings={projectRings} />
        )}
      </CardContent>
    </Card>
  );
}

function Summary({
  sync,
  locale,
  projectRings,
}: {
  sync: RingsWalletSync;
  locale: string;
  projectRings: readonly ProjectRing[];
}) {
  const t = useTranslations();

  if (sync.balances.length === 0) {
    return (
      <p className="text-2xl font-semibold tabular-nums text-primary">
        {formatCurrencyAmount(0, locale)}
      </p>
    );
  }

  const nameByProgramId = ringNameByProgramId(projectRings);
  const groups = groupByRing(sync.balances);

  return (
    <div className="flex flex-col gap-2">
      {typeof sync.totalUsd === "number" ? (
        <p className="text-2xl font-semibold tabular-nums text-primary">
          {formatCurrencyAmount(sync.totalUsd, locale)}
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.ring ?? "default"} className="flex flex-col gap-0.5">
          {groups.length > 1 ? (
            <p className="text-xs text-tertiary">
              {group.ring === null
                ? t("DashboardHeliusRings.overview.defaultRing")
                : (nameByProgramId.get(group.ring) ??
                  t("DashboardHeliusRings.overview.customRing", {
                    id: shortenShieldedAddress(group.ring),
                  }))}
            </p>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {group.balances.map((balance) => (
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
      ))}
    </div>
  );
}
