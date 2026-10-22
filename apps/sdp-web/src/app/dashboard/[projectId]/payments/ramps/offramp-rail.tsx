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
      return t("DashboardPayments.counterparty.next");
  }
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
  const liveTransferState = wizard.onTransactionStage ? transferState : null;
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
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        !wizard.canProceed ||
        (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={offrampPrimaryLabel(wizard, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={wizard.isLastStep ? wizard.finish : () => void wizard.handlePrimary()}
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
      secondaryLabel={cancelable ? t("DashboardPayments.ramps.cancelPayout") : undefined}
      confirmSecondary={cancelable}
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading || wizard.quoteInFlight}
      hideSecondary={liveTransferState !== null && !liveTransferState.cancelable}
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
