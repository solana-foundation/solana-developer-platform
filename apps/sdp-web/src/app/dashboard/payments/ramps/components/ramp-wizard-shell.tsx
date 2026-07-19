"use client";

import type { Counterparty, RampProviderId } from "@sdp/types";
import { motion } from "motion/react";
import Image from "next/image";
import { type ReactNode, useState } from "react";
import { CounterpartyCreateDialog } from "@/app/dashboard/payments/counterparty/counterparty-create-dialog";
import { PaymentsWizardFrame } from "@/app/dashboard/payments/payments-wizard-frame";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { getRampProviderLabel, RAMP_PROVIDER_LOGOS } from "@/lib/ramps";
import { CancelTransactionDialog } from "./cancel-transaction-dialog";

export function PoweredByRampProvider({ provider }: { provider: RampProviderId }) {
  const t = useTranslations();
  const providerLabel = getRampProviderLabel(provider);

  return (
    <div className="flex items-center justify-center gap-2 text-sm text-tertiary">
      <span>{t("DashboardPayments.poweredBy")}</span>
      <Image
        src={RAMP_PROVIDER_LOGOS[provider]}
        alt=""
        width={24}
        height={24}
        className="size-6 rounded-md object-contain"
      />
      <span className="font-medium text-secondary">{providerLabel}</span>
    </div>
  );
}

interface RampWizardShellProps {
  steps: readonly { label: string; title: string }[];
  stepIndex: number;
  primaryDisabled: boolean;
  primaryLabel: string;
  /** Overrides the default Cancel/Previous secondary label. */
  secondaryLabel?: string;
  walletsError: string | null;
  onPrimary: () => void;
  onSecondary: () => void;
  counterpartyDialogOpen: boolean;
  setCounterpartyDialogOpen: (open: boolean) => void;
  onCounterpartyCreated: (created: Counterparty) => void;
  children: ReactNode;
  /** Rendered top-right, next to the step title (e.g. the "Powered by" badge). */
  header?: ReactNode;
  footerActions?: ReactNode;
  hidePrimary?: boolean;
  /** Confirm before running the secondary action — used once a transaction is live. */
  confirmSecondary?: boolean;
  secondaryDisabled?: boolean;
  hideSecondary?: boolean;
}

export function RampWizardShell({
  steps,
  stepIndex,
  primaryDisabled,
  primaryLabel,
  secondaryLabel,
  walletsError,
  onPrimary,
  onSecondary,
  counterpartyDialogOpen,
  setCounterpartyDialogOpen,
  onCounterpartyCreated,
  children,
  header,
  footerActions,
  hidePrimary,
  confirmSecondary,
  secondaryDisabled,
  hideSecondary,
}: RampWizardShellProps) {
  const t = useTranslations();
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  return (
    <>
      <PaymentsWizardFrame
        steps={steps}
        currentStep={stepIndex}
        progressLabel={t("DashboardPayments.counterparty.stepProgress", {
          current: stepIndex + 1,
          total: steps.length,
        })}
        header={header}
        footer={
          <div className="flex items-center justify-between gap-3">
            {hideSecondary ? (
              <div />
            ) : (
              <Button
                type="button"
                variant="secondary"
                disabled={secondaryDisabled}
                onClick={confirmSecondary ? () => setCancelConfirmOpen(true) : onSecondary}
              >
                {secondaryLabel ??
                  (stepIndex === 0
                    ? t("DashboardPayments.counterparty.cancel")
                    : t("DashboardPayments.previous"))}
              </Button>
            )}
            <div className="ml-auto flex items-center gap-3">
              {footerActions}
              {hidePrimary ? null : (
                <Button type="button" disabled={primaryDisabled} onClick={onPrimary}>
                  {primaryLabel}
                </Button>
              )}
            </div>
          </div>
        }
      >
        <div className="space-y-6">
          {walletsError ? (
            <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
              {walletsError}
            </div>
          ) : null}

          <motion.div
            key={stepIndex}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="space-y-6"
          >
            {children}
          </motion.div>
        </div>
      </PaymentsWizardFrame>

      <CounterpartyCreateDialog
        open={counterpartyDialogOpen}
        onClose={() => setCounterpartyDialogOpen(false)}
        onCreated={onCounterpartyCreated}
      />

      <CancelTransactionDialog
        open={cancelConfirmOpen}
        onKeepGoing={() => setCancelConfirmOpen(false)}
        onCancel={() => {
          setCancelConfirmOpen(false);
          onSecondary();
        }}
      />
    </>
  );
}
