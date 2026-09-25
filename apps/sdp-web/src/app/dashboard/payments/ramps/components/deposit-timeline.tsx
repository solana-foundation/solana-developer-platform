"use client";

import type { PaymentTransferStatus } from "@sdp/types";
import { useTranslations } from "@/i18n/provider";
import { cn } from "@/lib/utils";
import { depositStageStates } from "./deposit-timeline-stages";

/** Quote agreed → Funds sent → Received by provider, as a vertical rail. */
export function DepositTimeline({ status }: { status: PaymentTransferStatus | undefined }) {
  const t = useTranslations();
  const labels = [
    t("DashboardPayments.depositTimeline.quoteAgreed"),
    t("DashboardPayments.depositTimeline.fundsSent"),
    t("DashboardPayments.depositTimeline.receivedByProvider"),
  ];
  const states = depositStageStates(status);
  return (
    <ol className="space-y-0" aria-label={t("DashboardPayments.depositTimeline.label")}>
      {labels.map((label, index) => {
        const state = states[index];
        return (
          <li key={label} className="relative flex gap-4 pb-6 last:pb-0">
            {index < labels.length - 1 ? (
              <span
                aria-hidden="true"
                className="absolute top-3 left-[3.5px] h-full w-px bg-border-strong"
              />
            ) : null}
            <span
              aria-hidden="true"
              className={cn(
                "relative mt-1.5 size-2 shrink-0 rounded-full",
                state === "upcoming"
                  ? "border border-border-strong bg-surface-raised"
                  : "bg-secondary"
              )}
            />
            <span
              className={cn(
                "text-body",
                state === "current"
                  ? "font-medium text-primary"
                  : state === "done"
                    ? "text-secondary"
                    : "text-tertiary"
              )}
            >
              {label}
              {state === "current" ? (
                <span className="sr-only"> {t("DashboardPayments.depositTimeline.current")}</span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
