"use client";

/**
 * Settle and cancel.
 *
 * Only cancel is held. The house rule for hold-to-confirm is a destructive act
 * with no way back (HOO-1230), and cancel is that: it abandons the trade and
 * refunds both legs. Settling is the outcome the trade exists for, and putting
 * the same friction on it would make the intended path look as risky as
 * walking away from it.
 *
 * Both close the trade for good, so both carry their own explanation.
 */

import { Button } from "@/components/ui/button";
import { HoldToConfirmButton } from "@/components/ui/hold-to-confirm-button";
import { useTranslations } from "@/i18n/provider";
import type { DvpTrade } from "./dvp-trade";
import { canCancelDvpTrade, canSettleDvpTrade } from "./dvp-trade";
import type { DvpTradeActionName } from "./use-dvp-trade-actions";

export function DvpCloseActions({
  onAct,
  pending,
  trade,
}: {
  onAct: (action: DvpTradeActionName) => void;
  pending: DvpTradeActionName | null;
  trade: DvpTrade;
}) {
  const t = useTranslations();
  if (!canCancelDvpTrade(trade)) {
    return null;
  }
  const canSettle = canSettleDvpTrade(trade);

  return (
    <section className="rounded-2xl border border-border-default bg-surface-raised p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Button
            className="self-start"
            disabled={!canSettle || pending !== null}
            onClick={() => onAct("settle")}
            type="button"
          >
            {t("DashboardMarkets.dvp.actionSettle")}
          </Button>
          <p className="text-secondary text-xs leading-relaxed">
            {t("DashboardMarkets.dvp.settleHint")}
          </p>
          {canSettle ? null : (
            <p className="text-tertiary text-xs">{t("DashboardMarkets.dvp.settleBlocked")}</p>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <HoldToConfirmButton
            className="self-start"
            disabled={pending !== null}
            label={t("DashboardMarkets.dvp.actionCancel")}
            onConfirm={() => onAct("cancel")}
          />
          <p className="text-secondary text-xs leading-relaxed">
            {t("DashboardMarkets.dvp.cancelHint")}
          </p>
        </div>
      </div>
    </section>
  );
}
