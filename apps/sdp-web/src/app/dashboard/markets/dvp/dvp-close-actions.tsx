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

import { Loader2Icon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useTranslations } from "@/i18n/provider";
import { formatTimestamp } from "../../payments/payments-overview.utils";
import type { DvpTrade } from "./dvp-trade";
import { canCancelDvpTrade } from "./dvp-trade";
import type { DvpPendingAction } from "./use-dvp-trade-actions";

/** Shown in place of a button's icon while its request is out. */
const PENDING_ICON = <Loader2Icon aria-hidden className="animate-spin" />;

export function DvpCloseActions({
  onAct,
  pending,
  trade,
}: {
  onAct: (action: "settle" | "cancel") => void;
  pending: ReadonlySet<DvpPendingAction>;
  trade: DvpTrade;
}) {
  const t = useTranslations();
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  if (!canCancelDvpTrade(trade)) {
    return null;
  }
  // The API's answer, by the cluster clock the program checks. Null means it has
  // not been observed with one yet, so Settle stays off until it has.
  const settle = trade.settlementAvailability;
  const settling = pending.has("settle");
  const cancelling = pending.has("cancel");

  return (
    <div className="flex flex-col gap-3">
      {/* Past expiry the program refuses Settle for good, and the next-step line
          already says Cancel is the way out, so a dead Settle panel only offers
          an action that cannot happen. A settle already in flight keeps its
          panel: the page can refresh to expired while it is still confirming. */}
      {settle === "expired" && !settling ? null : (
        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-default bg-surface-raised px-5 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-primary text-sm">
              {t("DashboardMarkets.dvp.actionSettle")}
            </h3>
            <p className="mt-0.5 text-secondary text-xs leading-relaxed">
              {t("DashboardMarkets.dvp.settleHint")}
              {settle === "unfunded" ? (
                <span className="text-tertiary"> {t("DashboardMarkets.dvp.settleBlocked")}</span>
              ) : null}
              {settle === "too_early" && trade.earliestSettlementTimestamp !== null ? (
                <span className="text-tertiary" suppressHydrationWarning>
                  {" "}
                  {t("DashboardMarkets.dvp.settleTooEarly", {
                    when: formatTimestamp(
                      new Date(Number(trade.earliestSettlementTimestamp) * 1000).toISOString(),
                      t
                    ),
                  })}
                </span>
              ) : null}
            </p>
          </div>
          <Button
            className="shrink-0"
            disabled={settle !== "available" || pending.size > 0}
            iconLeft={settling ? PENDING_ICON : undefined}
            onClick={() => onAct("settle")}
            type="button"
          >
            {t(
              settling ? "DashboardMarkets.dvp.actionSettling" : "DashboardMarkets.dvp.actionSettle"
            )}
          </Button>
        </section>
      )}
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border-default bg-surface-raised px-5 py-4">
        <div className="min-w-0 flex-1">
          <h3 className="font-medium text-primary text-sm">
            {t("DashboardMarkets.dvp.actionCancel")}
          </h3>
          <p className="mt-0.5 text-secondary text-xs leading-relaxed">
            {t("DashboardMarkets.dvp.cancelHint")}
          </p>
        </div>
        <Button
          className="shrink-0 text-destructive"
          disabled={pending.size > 0}
          iconLeft={cancelling ? PENDING_ICON : undefined}
          onClick={() => setConfirmingCancel(true)}
          type="button"
          variant="outline"
        >
          {t(
            cancelling
              ? "DashboardMarkets.dvp.actionCancelling"
              : "DashboardMarkets.dvp.actionCancel"
          )}
        </Button>
      </section>

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
              disabled={pending.size > 0}
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
    </div>
  );
}
