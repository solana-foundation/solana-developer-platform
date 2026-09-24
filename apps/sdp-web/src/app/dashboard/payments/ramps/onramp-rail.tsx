"use client";

import { isRampOnboardingPendingStatus } from "@sdp/types/ramp-requirements";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { getRampProviderLabel } from "@/lib/ramps";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";
import { WizardSummaryList } from "../wizard-summary-list";
import type { ContactControls } from "./components/contact-combobox";
import { OnrampStepContent } from "./components/onramp-step-content";
import { ProviderSummaryTrigger } from "./components/provider-summary-trigger";
import { RampStatusInline } from "./components/ramp-status-panel";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type OnrampWizard, useOnrampWizard } from "./hooks/use-onramp-wizard";
import type { RailProps } from "./ramp-action-page";
import { getRampTransferState } from "./ramp-transfer-state";
import { preStepSummaryDetails } from "./wizard-summary";

function onrampPrimaryLabel(
  wizard: OnrampWizard,
  verificationPending: boolean,
  verificationUrl: string | undefined,
  t: ReturnType<typeof useTranslations>
): string {
  switch (true) {
    case wizard.hostedQuoteLoading:
      return t("DashboardPayments.processing");
    case verificationPending:
      return t("DashboardPayments.verificationPending");
    case verificationUrl !== undefined:
      return t("DashboardPayments.completeVerification");
    case wizard.currentStepId === "REQUIREMENTS" && wizard.pendingAgreements !== null:
      return t("DashboardPayments.bvnk.acceptAgreements");
    case wizard.currentStepId === "REVIEW" && wizard.fields.provider !== null:
      return t("DashboardPayments.ramps.continueWithProvider", {
        provider: getRampProviderLabel(wizard.fields.provider),
      });
    default:
      return t("DashboardPayments.ramps.continue");
  }
}

function onrampPrimaryAction(
  wizard: OnrampWizard,
  verificationUrl: string | undefined
): () => void {
  switch (true) {
    case verificationUrl !== undefined:
      return () => openExternalRampUrl(verificationUrl);
    case wizard.isLastStep:
      return wizard.finish;
    default:
      return () => void wizard.handlePrimary();
  }
}

/**
 * The wizard's steps as the frame shows them: the provider's name in "What {provider} needs",
 * and the memo step called "Memo" when a separate requirements step already took the
 * "Provider details" name.
 */
function displaySteps(wizard: OnrampWizard, t: ReturnType<typeof useTranslations>) {
  const provider = wizard.fields.provider ? getRampProviderLabel(wizard.fields.provider) : null;
  const needsTitle = provider
    ? t("DashboardPayments.ramps.whatProviderNeeds", { provider })
    : undefined;
  const hasRequirements = wizard.steps.some((step) => step.id === "REQUIREMENTS");
  return wizard.steps.map((step) => {
    if (step.id === "REQUIREMENTS") return { ...step, title: needsTitle ?? step.title };
    if (step.id === "MEMO") {
      return hasRequirements
        ? { ...step, label: t("DashboardPayments.ramps.memoStep") }
        : { ...step, title: needsTitle ?? step.title };
    }
    return step;
  });
}

export function OnrampRail({
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
  contact,
  onCancel,
}: RailProps & {
  /** The contact picker at the top of the details step; the contact is fixed without it. */
  contact?: ContactControls;
  /** Leaves the flow before a transfer exists (the footer's Cancel). */
  onCancel?: () => void;
}) {
  const t = useTranslations();
  const wizard = useOnrampWizard({
    wallets,
    walletsError,
    enabledRampProviders,
    rampProviderAccess,
    counterpartiesResult,
    selectedCounterparty,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  const onOnboardingStep =
    wizard.currentStepId === "PROVIDER" || wizard.currentStepId === "REQUIREMENTS";

  const verificationUrl =
    onOnboardingStep && wizard.onboarding?.status === "customer_verification_required"
      ? wizard.onboarding.verificationUrl
      : undefined;

  const verificationPending =
    onOnboardingStep &&
    wizard.onboarding !== null &&
    isRampOnboardingPendingStatus(wizard.onboarding.status);

  const summaryDetails = [
    ...preStepSummaryDetails(t, counterpartyName, methodLabel),
    ...wizard.summaryDetails,
  ];
  const hostedStage = wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted";
  const showInlineStatus = wizard.onTransactionStage && Boolean(wizard.quote);
  const transferState =
    wizard.transferStatus === undefined ? null : getRampTransferState(wizard.transferStatus.status);
  const cancelable = transferState !== null && transferState.cancelable;
  return (
    <RampWizardShell
      steps={[...preSteps, ...displaySteps(wizard, t)]}
      stepIndex={preSteps.length + wizard.stepIndex}
      footerHint={
        wizard.currentStepId === "DEPOSIT" && wizard.fields.provider === null
          ? t("DashboardPayments.ramps.pickProviderHint")
          : undefined
      }
      onCancel={
        wizard.onTransactionStage ? (cancelable ? wizard.handleSecondary : undefined) : onCancel
      }
      cancelLabel={
        wizard.onTransactionStage ? t("DashboardPayments.ramps.cancelDeposit") : undefined
      }
      confirmCancel={wizard.onTransactionStage && cancelable}
      completionTitle={
        wizard.transferStatus?.status === "completed"
          ? t("DashboardPayments.ramps.depositComplete")
          : undefined
      }
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        verificationPending ||
        !wizard.canProceed ||
        (wizard.currentStepId === "DEPOSIT" && wizard.walletsLoading)
      }
      primaryLabel={onrampPrimaryLabel(wizard, verificationPending, verificationUrl, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={onrampPrimaryAction(wizard, verificationUrl)}
      onSecondary={wizard.handleSecondary}
      counterpartyDialog={null}
      summary={
        wizard.fields.provider === null ? undefined : <WizardSummaryList details={summaryDetails} />
      }
      summaryTrigger={
        wizard.fields.provider === null ? undefined : (
          <ProviderSummaryTrigger provider={wizard.fields.provider} />
        )
      }
      header={
        showInlineStatus ? (
          <RampStatusInline
            direction="onramp"
            hosted={hostedStage}
            transfer={wizard.transferStatus}
          />
        ) : undefined
      }
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading}
      // Once the quote exists there is nothing to go back to; the footer's Cancel deposit
      // (confirmed) is the way out while the transfer can still be canceled.
      hideSecondary={wizard.onTransactionStage}
      footerActions={
        wizard.quoteTransferId !== null && wizard.onTransactionStage ? (
          <Button asChild type="button">
            <Link
              href={`/dashboard/payments/transactions?module=payments&search=${encodeURIComponent(wizard.quoteTransferId)}`}
            >
              {t("DashboardPayments.depositAddress.openInTransactions")}
            </Link>
          </Button>
        ) : null
      }
      hidePrimary={wizard.currentStepId === "PROVIDER" && !verificationUrl}
    >
      <OnrampStepContent wizard={wizard} contact={contact} />
    </RampWizardShell>
  );
}
