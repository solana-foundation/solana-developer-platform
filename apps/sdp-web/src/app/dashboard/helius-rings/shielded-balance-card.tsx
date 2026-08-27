"use client";

import { Loader2, RefreshCw } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale, useTranslations } from "@/i18n/provider";
import {
  type RingsShieldedBalance,
  type RingsWallet,
  type RingsWalletSync,
  syncRingsWallet,
} from "./helius-rings.data";
import { formatWhen, readShieldedAmount } from "./helius-rings.utils";

/**
 * What the last read established. `unsynced` is distinct from an observed
 * empty wallet: collapsing them would show a zero balance for a wallet nobody
 * has read.
 */
type Observation =
  | { name: "unsynced" }
  | { name: "observed"; sync: RingsWalletSync }
  | { name: "failed"; message: string };

/**
 * One wallet's shielded balance. The read is a full indexer scan, so it never
 * polls and never fires on mount — only the refresh press triggers it.
 */
export function ShieldedBalanceCard({ wallet }: { wallet: RingsWallet }) {
  const t = useTranslations();
  const locale = useLocale();

  const [observation, setObservation] = useState<Observation>({ name: "unsynced" });
  const [reading, setReading] = useState(false);

  const provisioned = wallet.shieldedAddress !== null;
  const refreshLabel = t(
    reading ? "DashboardHeliusRings.balances.refreshing" : "DashboardHeliusRings.balances.refresh"
  );

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
      // No reply at all — offline, or aborted. Uncaught, the button would sit
      // disabled on "refreshing" with no answer coming.
      setObservation({
        name: "failed",
        message: t("DashboardHeliusRings.balances.readFailed"),
      });
    } finally {
      setReading(false);
    }
  }, [wallet.id, t]);

  return (
    <div className="flex min-w-0 items-start gap-1">
      <Button
        variant="ghost"
        size="icon-xs"
        disabled={reading || !provisioned}
        aria-label={refreshLabel}
        title={refreshLabel}
        onClick={() => void handleRefresh()}
      >
        {reading ? (
          <Loader2 className="animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw aria-hidden="true" />
        )}
      </Button>

      <div className="min-w-0 flex-1">
        {/* Text, not a tooltip on the disabled button: a disabled button takes
            no focus, so its title is unreachable by keyboard and screen reader. */}
        {!provisioned ? (
          <p className="text-pretty break-words text-sm text-secondary">
            {t("DashboardHeliusRings.balances.notProvisioned")}
          </p>
        ) : null}

        {observation.name === "unsynced" && !reading && provisioned ? (
          <p className="text-sm text-secondary">{t("DashboardHeliusRings.balances.unsynced")}</p>
        ) : null}

        {observation.name === "failed" ? (
          <p className="text-pretty break-words text-xs text-error" role="alert">
            {observation.message}
          </p>
        ) : null}

        {observation.name === "observed" ? (
          <ObservedBalances locale={locale} sync={observation.sync} />
        ) : null}
      </div>
    </div>
  );
}

function ObservedBalances({ locale, sync }: { locale: string; sync: RingsWalletSync }) {
  const t = useTranslations();

  return (
    <div className="flex min-w-0 flex-col gap-1">
      {/* The warning stands whether rows came back or not: "nothing in the part
          I could read" must never read as "this wallet holds nothing". */}
      {sync.degraded ? (
        <p className="text-pretty break-words text-xs text-warning">
          {t("DashboardHeliusRings.balances.degraded")}
        </p>
      ) : null}

      {sync.balances.length === 0 ? (
        sync.degraded ? null : (
          <p className="text-pretty break-words text-sm text-secondary">
            {t("DashboardHeliusRings.balances.empty")}
          </p>
        )
      ) : (
        <ul className="flex min-w-0 flex-col gap-0.5">
          {sync.balances.map((balance) => (
            <li
              key={balance.mint}
              className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm"
            >
              <span className="tabular-nums">
                <Amount balance={balance} />
              </span>
              <span className="text-secondary">{balance.symbol}</span>
            </li>
          ))}
        </ul>
      )}

      <p className="text-pretty break-words text-xs text-tertiary">
        {t("DashboardHeliusRings.balances.observedAt", {
          when: formatWhen(sync.observedAt, locale),
        })}
      </p>
    </div>
  );
}

/**
 * Never places a point the server gave no scale for — a USDC note read as
 * whole units is a million-fold overstatement — and renders nothing at all for
 * a non-integer amount, since a fabricated 0 is worse than no figure.
 */
function Amount({ balance }: { balance: RingsShieldedBalance }) {
  const t = useTranslations();
  const amount = readShieldedAmount(balance.amountRaw, balance.decimals);

  if (amount.scale === "unrenderable") return <>—</>;
  if (amount.scale === "baseUnits") {
    return <>{t("DashboardHeliusRings.balances.baseUnitsAmount", { amount: amount.text })}</>;
  }
  return <>{amount.text}</>;
}
