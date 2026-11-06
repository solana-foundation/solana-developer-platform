"use client";

import type { Counterparty } from "@sdp/types/counterparties";
import { Button } from "@sdp/ui/button";
import { type ReactNode, useState } from "react";
import { CounterpartyCreateDialog } from "@/app/(session)/dashboard/[projectId]/payments/counterparty/counterparty-create-dialog";
import { WizardFrame } from "@/components/wizard-frame";
import { useTranslations } from "@/i18n/provider";
import { CancelTransactionDialog } from "./cancel-transaction-dialog";

interface RampWizardShellProps {
  steps: readonly { label: string; title: string }[];
  stepIndex: number;
  primaryDisabled: boolean;
  primaryLabel: string;
  /** Spins the primary action in place while what it started runs; its label and width hold. */
  primaryLoading?: boolean;
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
   * Leaves the whole flow, set as a quiet "Cancel" beside the primary action. With it, the
   * secondary action is "Back" on the left from the second step on.
   */
  onCancel?: () => void;
  /** The Cancel's label (default "Cancel"). */
  cancelLabel?: string;
  /** Confirm before running `onCancel`, as for a live transaction. */
  confirmCancel?: boolean;
  /** Holds the Cancel while the request it would start is in flight. */
  cancelDisabled?: boolean;
  /** What the primary action is waiting for, on the footer's left. */
  footerHint?: ReactNode;
}

/**
 * The wizard footer: Back (or a hint) on the left; Cancel and the primary action on the right. A primary action that cannot run yet is drawn outlined, as the design does, so the
 * band never shows a filled button that does nothing.
 */
function RampFooter({
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
  cancel: { label: string; disabled: boolean; onClick: () => void } | null;
  hint: ReactNode;
  actions: ReactNode;
  primary: { label: string; disabled: boolean; loading?: boolean; onClick: () => void } | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      {showBack ? (
        <Button type="button" variant="outline" disabled={backDisabled} onClick={onBack}>
          {backLabel}
        </Button>
      ) : hint ? (
        <p className="min-w-0 text-meta text-secondary">{hint}</p>
      ) : null}
      <div className="ml-auto flex items-center gap-4">
        {actions}
        {cancel ? (
          <Button type="button" variant="ghost" disabled={cancel.disabled} onClick={cancel.onClick}>
            {cancel.label}
          </Button>
        ) : null}
        {primary ? (
          <Button
            type="button"
            // A running action stays filled under its spinner rather than reading as unavailable.
            variant={primary.disabled && !primary.loading ? "outline" : "default"}
            disabled={primary.disabled}
            loading={primary.loading}
            onClick={primary.onClick}
          >
            {primary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The footer for where the wizard is: Back from the second step on, the flow's own Cancel (or
 * the first step's secondary action, which is a cancel there) and the primary action.
 */
function wizardFooter({
  stepIndex,
  primary,
  secondaryLabel,
  secondaryDisabled,
  hideSecondary,
  onSecondaryClick,
  cancel,
  footerHint,
  footerActions,
  t,
}: {
  stepIndex: number;
  primary: { label: string; disabled: boolean; loading?: boolean; onClick: () => void } | null;
  secondaryLabel: string | undefined;
  secondaryDisabled: boolean | undefined;
  hideSecondary: boolean | undefined;
  onSecondaryClick: () => void;
  cancel: { label: string; disabled: boolean; onClick: () => void } | null;
  footerHint: ReactNode;
  footerActions: ReactNode;
  t: ReturnType<typeof useTranslations>;
}): ReactNode {
  const footerCancel =
    cancel ??
    (stepIndex === 0 && hideSecondary !== true
      ? {
          label: secondaryLabel ?? t("DashboardPayments.counterparty.cancel"),
          disabled: false,
          onClick: onSecondaryClick,
        }
      : null);
  return (
    <RampFooter
      showBack={hideSecondary !== true && stepIndex > 0}
      backLabel={secondaryLabel ?? t("DashboardPayments.back")}
      backDisabled={secondaryDisabled === true}
      onBack={onSecondaryClick}
      cancel={footerCancel}
      hint={footerHint}
      actions={footerActions}
      primary={primary}
    />
  );
}

/** The two actions the confirm dialog can stand in front of. */
type ConfirmTarget = "secondary" | "cancel";

/**
 * The confirm-before-leaving dialog's state: which action it guards, whether it is open, and
 * what its two buttons do. The dialog only shows while the action it guards may still run.
 */
function useLeaveConfirmation({
  confirmSecondary,
  hideSecondary,
  secondaryDisabled,
  confirmCancel,
  cancelDisabled,
  onCancel,
  onSecondary,
}: {
  confirmSecondary: boolean | undefined;
  hideSecondary: boolean | undefined;
  secondaryDisabled: boolean | undefined;
  confirmCancel: boolean | undefined;
  cancelDisabled: boolean | undefined;
  onCancel: (() => void) | undefined;
  onSecondary: () => void;
}) {
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false);
  // What the confirm dialog runs: the secondary action, or the footer's Cancel.
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>("secondary");
  const cancelConfirmationAvailable =
    confirmTarget === "cancel"
      ? confirmCancel === true && onCancel !== undefined && cancelDisabled !== true
      : confirmSecondary === true && hideSecondary !== true && secondaryDisabled !== true;
  const askToConfirm = (target: ConfirmTarget) => () => {
    setConfirmTarget(target);
    setCancelConfirmOpen(true);
  };
  const keepGoing = () => {
    setCancelConfirmOpen(false);
    setConfirmTarget("secondary");
  };
  const confirmLeave = () => {
    setCancelConfirmOpen(false);
    if (!cancelConfirmationAvailable) return;
    if (confirmTarget === "cancel") {
      onCancel?.();
    } else {
      onSecondary();
    }
    setConfirmTarget("secondary");
  };
  return {
    open: cancelConfirmOpen && cancelConfirmationAvailable,
    askToConfirm,
    keepGoing,
    confirmLeave,
  };
}

/**
 * The footer the shell hands the frame, or none when the step hides both actions and has no
 * extra ones. Actions that need a confirmation open the dialog instead of running.
 */
function shellFooter({
  stepIndex,
  primaryLabel,
  primaryDisabled,
  primaryLoading,
  onPrimary,
  hidePrimary,
  secondaryLabel,
  secondaryDisabled,
  hideSecondary,
  confirmSecondary,
  onSecondary,
  onCancel,
  cancelLabel,
  confirmCancel,
  cancelDisabled,
  askToConfirm,
  footerHint,
  footerActions,
  t,
}: {
  stepIndex: number;
  primaryLabel: string;
  primaryDisabled: boolean;
  primaryLoading: boolean | undefined;
  onPrimary: () => void;
  hidePrimary: boolean | undefined;
  secondaryLabel: string | undefined;
  secondaryDisabled: boolean | undefined;
  hideSecondary: boolean | undefined;
  confirmSecondary: boolean | undefined;
  onSecondary: () => void;
  onCancel: (() => void) | undefined;
  cancelLabel: string | undefined;
  confirmCancel: boolean | undefined;
  cancelDisabled: boolean | undefined;
  askToConfirm: (target: ConfirmTarget) => () => void;
  footerHint: ReactNode;
  footerActions: ReactNode;
  t: ReturnType<typeof useTranslations>;
}): ReactNode {
  // A Cancel alone keeps the footer: an open sale waiting on its deposit address.
  const showFooter =
    hideSecondary !== true ||
    hidePrimary !== true ||
    footerActions != null ||
    onCancel !== undefined;
  if (!showFooter) {
    return undefined;
  }
  return wizardFooter({
    stepIndex,
    primary: hidePrimary
      ? null
      : {
          label: primaryLabel,
          disabled: primaryDisabled,
          loading: primaryLoading,
          onClick: onPrimary,
        },
    secondaryLabel,
    secondaryDisabled,
    hideSecondary,
    onSecondaryClick: confirmSecondary ? askToConfirm("secondary") : onSecondary,
    cancel: onCancel
      ? {
          label: cancelLabel ?? t("DashboardPayments.counterparty.cancel"),
          disabled: cancelDisabled === true,
          onClick: confirmCancel ? askToConfirm("cancel") : onCancel,
        }
      : null,
    footerHint,
    footerActions,
    t,
  });
}

export function RampWizardShell({
  steps,
  stepIndex,
  primaryDisabled,
  primaryLabel,
  primaryLoading,
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
  cancelDisabled,
  footerHint,
}: RampWizardShellProps) {
  const t = useTranslations();
  const confirmation = useLeaveConfirmation({
    confirmSecondary,
    hideSecondary,
    secondaryDisabled,
    confirmCancel,
    cancelDisabled,
    onCancel,
    onSecondary,
  });
  const isLastStep = stepIndex === steps.length - 1;
  const footer = shellFooter({
    stepIndex,
    primaryLabel,
    primaryDisabled,
    primaryLoading,
    onPrimary,
    hidePrimary,
    secondaryLabel,
    secondaryDisabled,
    hideSecondary,
    confirmSecondary,
    onSecondary,
    onCancel,
    cancelLabel,
    confirmCancel,
    cancelDisabled,
    askToConfirm: confirmation.askToConfirm,
    footerHint,
    footerActions,
    t,
  });
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
        footer={footer}
      >
        <div className="space-y-6">
          {walletsError ? (
            <div className="rounded-lg border border-error-border bg-error-bg px-4 py-3 text-sm text-error">
              {walletsError}
            </div>
          ) : null}

          {/* Each step mounts fresh; the frame fades it in. */}
          <div key={stepIndex} className="space-y-6">
            {children}
          </div>
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
        open={confirmation.open}
        onKeepGoing={confirmation.keepGoing}
        onCancel={confirmation.confirmLeave}
      />
    </>
  );
}
