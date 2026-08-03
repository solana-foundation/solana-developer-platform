"use client";

import type { Counterparty } from "@sdp/types";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { CounterpartyCreateDialog } from "@/app/dashboard/payments/counterparty/counterparty-create-dialog";
import { Button } from "@/components/ui/button";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { CancelTransactionDialog } from "./cancel-transaction-dialog";

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
  summary?: ReactNode;
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
  summary,
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
      <WizardFrame
        steps={steps}
        currentStep={stepIndex}
        progressLabel={t("DashboardPayments.counterparty.stepProgress", {
          current: stepIndex + 1,
          total: steps.length,
        })}
        header={header}
        summary={summary}
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
      </WizardFrame>

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
