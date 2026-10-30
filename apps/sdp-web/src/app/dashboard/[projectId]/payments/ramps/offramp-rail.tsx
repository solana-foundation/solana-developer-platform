"use client";

import { WizardSummaryList } from "@/app/dashboard/[projectId]/payments/wizard-summary-list";
import { useTranslations } from "@/i18n/provider";
import { OfframpFooterActionButton } from "./components/offramp-final-step";
import { OfframpStepContent } from "./components/offramp-step-content";
import { ProviderSummaryTrigger } from "./components/provider-summary-trigger";
import { RampStatusInline } from "./components/ramp-status-panel";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type OfframpWizard, useOfframpWizard } from "./hooks/use-offramp-wizard";
import { offrampFooterAction } from "./offramp-footer-action";
import type { RailProps } from "./ramp-action-page";
import { getRampTransferState } from "./ramp-transfer-state";
import { preStepSummaryDetails } from "./wizard-summary";

type Translate = ReturnType<typeof useTranslations>;

function offrampPrimaryLabel(wizard: OfframpWizard, t: Translate): string {
  switch (true) {
    case wizard.hostedQuoteLoading:
      return t("DashboardPayments.processing");
    case wizard.isLastStep:
      return t("DashboardPayments.counterparty.done");
    default:
      return t("DashboardPayments.ramps.continue");
  }
}

function offrampPrimaryAction(wizard: OfframpWizard): () => void {
  switch (true) {
    case wizard.isLastStep:
      return wizard.finish;
    default:
      return () => void wizard.handlePrimary();
  }
}

/** Whether the footer's primary button waits: on a quote, or the wallets. */
function offrampPrimaryDisabled(wizard: OfframpWizard): boolean {
  return (
    wizard.hostedQuoteLoading ||
    !wizard.canProceed ||
    (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
  );
}

/** The final step's heading once the payout reached an outcome worth naming. */
function offrampCompletionTitle(wizard: OfframpWizard, t: Translate): string | undefined {
  if (wizard.transferStatus?.status === "completed") {
    return t("DashboardPayments.ramps.payoutComplete");
  }
  return undefined;
}

/** Whether the title row carries the polled transfer status. */
function showOfframpInlineStatus(wizard: OfframpWizard, hosted: boolean): boolean {
  if (!wizard.onTransactionStage) {
    return false;
  }
  return hosted || wizard.depositTarget !== null;
}

export function OfframpRail({
  wallets,
  walletsError,
  enabledRampProviders,
  rampProviderAccess,
  counterpartiesResult,
  selectedCounterparty,
  counterpartyId,
  counterpartyName,
  methodLabel,
  preSteps,
  onExit,
}: RailProps) {
  const t = useTranslations();
  const wizard = useOfframpWizard({
    wallets,
    walletsError,
    enabledRampProviders,
    rampProviderAccess,
    counterpartiesResult,
    selectedCounterparty,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  const transferState =
    wizard.transferStatus === undefined ? null : getRampTransferState(wizard.transferStatus.status);
  // Before the first status read the sale may still be open, so leaving it confirms first.
  const cancelable =
    wizard.onTransactionStage && (transferState === null || transferState.cancelable);
  const hosted = wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted";
  const footerAction = offrampFooterAction(wizard);
  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      completionTitle={offrampCompletionTitle(wizard, t)}
      primaryDisabled={offrampPrimaryDisabled(wizard)}
      primaryLabel={offrampPrimaryLabel(wizard, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={offrampPrimaryAction(wizard)}
      onSecondary={wizard.handleSecondary}
      counterpartyDialog={null}
      summary={
        wizard.fields.provider === null ? undefined : (
          <WizardSummaryList
            details={[
              ...preStepSummaryDetails(t, counterpartyName, methodLabel),
              ...wizard.summaryDetails,
            ]}
          />
        )
      }
      summaryTrigger={
        wizard.fields.provider === null ? undefined : (
          <ProviderSummaryTrigger provider={wizard.fields.provider} />
        )
      }
      header={
        showOfframpInlineStatus(wizard, hosted) ? (
          <RampStatusInline direction="offramp" hosted={hosted} transfer={wizard.transferStatus} />
        ) : undefined
      }
      // On the transaction stage the footer's Cancel payout (confirmed) is the way out, as on
      // the on-ramp; there is no step to go back to.
      onCancel={cancelable ? wizard.handleSecondary : undefined}
      cancelLabel={
        wizard.onTransactionStage ? t("DashboardPayments.ramps.cancelPayout") : undefined
      }
      confirmCancel={cancelable}
      cancelDisabled={wizard.isCanceling}
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading || wizard.quoteInFlight}
      hideSecondary={wizard.onTransactionStage}
      footerActions={
        footerAction === null ? undefined : (
          <OfframpFooterActionButton action={footerAction} wizard={wizard} />
        )
      }
      hidePrimary={wizard.currentStepId === "COMPLETE"}
    >
      <OfframpStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
