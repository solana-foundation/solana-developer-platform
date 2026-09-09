"use client";

/**
 * Settle and cancel.
 *
 * Both close the trade for good, so both carry their own explanation, and
 * cancel asks before it acts.
 *
 * A CONFIRM STEP, not a hold. A hold makes somebody press and wait without
 * telling them anything they did not already know, and it cannot be undone by
 * releasing early once the timer completes. A dialog states the consequence in
 * words and takes a deliberate second action — which is the actual point of
 * friction on an irreversible step.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
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
  const [confirmingCancel, setConfirmingCancel] = useState(false);
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
          <Button
            className="self-start"
            disabled={pending !== null}
            onClick={() => setConfirmingCancel(true)}
            type="button"
            variant="destructive"
          >
            {t("DashboardMarkets.dvp.actionCancel")}
          </Button>
          <p className="text-secondary text-xs leading-relaxed">
            {t("DashboardMarkets.dvp.cancelHint")}
          </p>
        </div>
      </div>

      <Modal
        ariaLabel={t("DashboardMarkets.dvp.cancelConfirmTitle")}
        isOpen={confirmingCancel}
        onClose={() => setConfirmingCancel(false)}
        size="sm"
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-2">
            <h2 className="font-medium text-primary text-sm">
              {t("DashboardMarkets.dvp.cancelConfirmTitle")}
            </h2>
            {/* Says what happens, not merely that it is permanent. "Cannot be
                undone" on its own tells somebody the stakes and not the
                outcome. */}
            <p className="text-secondary text-sm leading-relaxed">
              {t("DashboardMarkets.dvp.cancelConfirmBody")}
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => setConfirmingCancel(false)} type="button" variant="secondary">
              {t("DashboardMarkets.dvp.cancelConfirmDismiss")}
            </Button>
            <Button
              disabled={pending !== null}
              onClick={() => {
                setConfirmingCancel(false);
                onAct("cancel");
              }}
              type="button"
              variant="destructive"
            >
              {t("DashboardMarkets.dvp.cancelConfirmAccept")}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
