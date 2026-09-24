"use client";

import type { Counterparty } from "@sdp/types";
import { motion } from "motion/react";
import { type ReactNode, useState } from "react";
import { CounterpartyCreateDialog } from "@/app/dashboard/payments/counterparty/counterparty-create-dialog";
import { useThemeScope } from "@/components/theme-scope";
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
  counterpartyDialog: {
    open: boolean;
    setOpen: (open: boolean) => void;
    onCreated: (created: Counterparty) => void;
  } | null;
  children: ReactNode;
  /** Rendered top-right, next to the step title (e.g. the "Powered by" badge). */
  header?: ReactNode;
  summary?: ReactNode;
  /** Replaces the "View summary" button text (e.g. the provider-branded chip). */
  summaryTrigger?: ReactNode;
  footerActions?: ReactNode;
  hidePrimary?: boolean;
  /** Confirm before running the secondary action — used once a transaction is live. */
  confirmSecondary?: boolean;
  secondaryDisabled?: boolean;
  hideSecondary?: boolean;
  completionTitle?: string;
  /**
   * Refresh surfaces only: leaves the whole flow, set as a quiet "Cancel" beside the primary
   * action. With it, the secondary action is "Back" on the left from the second step on.
   */
  onCancel?: () => void;
  /** Refresh surfaces only: the Cancel's label (default "Cancel"). */
  cancelLabel?: string;
  /** Refresh surfaces only: confirm before running `onCancel`, as for a live transaction. */
  confirmCancel?: boolean;
  /** Refresh surfaces only: what the primary action is waiting for, on the footer's left. */
  footerHint?: ReactNode;
  /** Refresh surfaces only: set the review step's title at heading size. */
  prominentTitle?: boolean;
}

/**
 * The refresh wizard footer: Back (or a hint) on the left; Cancel and the primary action on
 * the right. A primary action that cannot run yet is drawn outlined, as the design does, so the
 * band never shows a filled button that does nothing.
 */
function RefreshFooter({
  showBack,
  backLabel,
  backDisabled,
  onBack,
  cancel,
  hint,
  actions,
  primary,
}: {
  showBack: boolean;
  backLabel: string;
  backDisabled: boolean;
  onBack: () => void;
  cancel: { label: string; onClick: () => void } | null;
  hint: ReactNode;
  actions: ReactNode;
  primary: { label: string; disabled: boolean; onClick: () => void } | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {showBack ? (
        <Button type="button" variant="outline" disabled={backDisabled} onClick={onBack}>
          {backLabel}
        </Button>
      ) : hint ? (
        <p className="min-w-0 text-body text-secondary">{hint}</p>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        {actions}
        {cancel ? (
          <Button type="button" variant="ghost" onClick={cancel.onClick}>
            {cancel.label}
          </Button>
        ) : null}
        {primary ? (
          <Button
            type="button"
            variant={primary.disabled ? "outline" : "default"}
            disabled={primary.disabled}
            onClick={primary.onClick}
          >
            {primary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The footer outside refresh surfaces: Previous or Cancel on the left, actions and primary right. */
function LegacyFooter({
  secondary,
  actions,
  primary,
}: {
  secondary: { label: string; disabled?: boolean; onClick: () => void } | null;
  actions?: ReactNode;
  primary: { label: string; disabled?: boolean; onClick: () => void } | null;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      {secondary ? (
        <Button
          type="button"
          variant="secondary"
          disabled={secondary.disabled}
          onClick={secondary.onClick}
        >
          {secondary.label}
        </Button>
      ) : (
        <div />
      )}
      <div className="ml-auto flex items-center gap-3">
        {actions}
        {primary ? (
          <Button type="button" disabled={primary.disabled} onClick={primary.onClick}>
            {primary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
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
  counterpartyDialog,
  children,
  header,
  summary,
  summaryTrigger,
  footerActions,
  hidePrimary,
  confirmSecondary,
  secondaryDisabled,
  hideSecondary,
  completionTitle,
  onCancel,
  cancelLabel,
  confirmCancel,
  footerHint,
  prominentTitle,
}: RampWizardShellProps) {
  const t = useTranslations();
  const refresh = useThemeScope() === "refresh";
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  // What the confirm dialog runs: the secondary action, or the refresh footer's Cancel.
  const [confirmTarget, setConfirmTarget] = useState<"secondary" | "cancel">("secondary");
  const cancelConfirmationAvailable =
    confirmTarget === "cancel"
      ? confirmCancel === true && onCancel !== undefined
      : confirmSecondary === true && hideSecondary !== true && secondaryDisabled !== true;
  const showFooter = hideSecondary !== true || hidePrimary !== true || footerActions != null;
  const isLastStep = stepIndex === steps.length - 1;
  const askToConfirm = (target: "secondary" | "cancel") => () => {
    setConfirmTarget(target);
    setCancelConfirmOpen(true);
  };
  const onSecondaryClick = confirmSecondary ? askToConfirm("secondary") : onSecondary;
  const primary = hidePrimary
    ? null
    : { label: primaryLabel, disabled: primaryDisabled, onClick: onPrimary };
  // The refresh footer's Cancel: the flow's own exit when it has one, else the first step's
  // secondary action (which is a cancel there).
  const refreshCancel = onCancel
    ? {
        label: cancelLabel ?? t("DashboardPayments.counterparty.cancel"),
        onClick: confirmCancel ? askToConfirm("cancel") : onCancel,
      }
    : stepIndex === 0 && hideSecondary !== true
      ? {
          label: secondaryLabel ?? t("DashboardPayments.counterparty.cancel"),
          onClick: onSecondaryClick,
        }
      : null;
  const legacySecondary = hideSecondary
    ? null
    : {
        label:
          secondaryLabel ??
          (stepIndex === 0
            ? t("DashboardPayments.counterparty.cancel")
            : t("DashboardPayments.previous")),
        disabled: secondaryDisabled,
        onClick: onSecondaryClick,
      };
  let footer: ReactNode;
  if (!showFooter) {
    footer = undefined;
  } else if (refresh) {
    footer = (
      <RefreshFooter
        showBack={hideSecondary !== true && stepIndex > 0}
        backLabel={secondaryLabel ?? t("DashboardPayments.back")}
        backDisabled={secondaryDisabled === true}
        onBack={onSecondaryClick}
        cancel={refreshCancel}
        hint={footerHint}
        actions={footerActions}
        primary={primary}
      />
    );
  } else {
    footer = <LegacyFooter secondary={legacySecondary} actions={footerActions} primary={primary} />;
  }
  return (
    <>
      <WizardFrame
        steps={steps}
        currentStep={stepIndex}
        currentStepTitle={completionTitle}
        progressLabel={t("DashboardPayments.counterparty.stepProgress", {
          current: stepIndex + 1,
          total: steps.length,
        })}
        header={header}
        summary={isLastStep ? undefined : summary}
        summaryTrigger={isLastStep ? undefined : summaryTrigger}
        prominentTitle={prominentTitle}
        footer={footer}
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

      {counterpartyDialog === null ? null : (
        <CounterpartyCreateDialog
          open={counterpartyDialog.open}
          onClose={() => counterpartyDialog.setOpen(false)}
          onCreated={counterpartyDialog.onCreated}
        />
      )}

      <CancelTransactionDialog
        open={cancelConfirmOpen && cancelConfirmationAvailable}
        onKeepGoing={() => {
          setCancelConfirmOpen(false);
          setConfirmTarget("secondary");
        }}
        onCancel={() => {
          setCancelConfirmOpen(false);
          if (!cancelConfirmationAvailable) return;
          if (confirmTarget === "cancel") {
            onCancel?.();
          } else {
            onSecondary();
          }
          setConfirmTarget("secondary");
        }}
      />
    </>
  );
}
