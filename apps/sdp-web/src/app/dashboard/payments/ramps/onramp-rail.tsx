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

/**
 * What the frame shows for where the deposit is: the verification the provider still wants,
 * whether the transfer can still be canceled, and the hints, labels and gates that follow.
 */
function onrampFrameState(
  wizard: OnrampWizard,
  onCancel: (() => void) | undefined,
  t: ReturnType<typeof useTranslations>
) {
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
  const transferState =
    wizard.transferStatus === undefined ? null : getRampTransferState(wizard.transferStatus.status);
  const cancelable = transferState?.cancelable === true;
  return {
    verificationUrl,
    verificationPending,
    footerHint:
      wizard.currentStepId === "DEPOSIT" && wizard.fields.provider === null
        ? t("DashboardPayments.ramps.pickProviderHint")
        : undefined,
    onCancel: wizard.onTransactionStage
      ? cancelable
        ? wizard.handleSecondary
        : undefined
      : onCancel,
    cancelLabel: wizard.onTransactionStage ? t("DashboardPayments.ramps.cancelDeposit") : undefined,
    confirmCancel: wizard.onTransactionStage && cancelable,
    completionTitle:
      wizard.transferStatus?.status === "completed"
        ? t("DashboardPayments.ramps.depositComplete")
        : undefined,
    primaryDisabled:
      wizard.hostedQuoteLoading ||
      verificationPending ||
      !wizard.canProceed ||
      (wizard.currentStepId === "DEPOSIT" && wizard.walletsLoading),
    hidePrimary: wizard.currentStepId === "PROVIDER" && !verificationUrl,
    hostedStage: wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted",
    showInlineStatus: wizard.onTransactionStage && Boolean(wizard.quote),
  };
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

  const frame = onrampFrameState(wizard, onCancel, t);
  const summaryDetails = [
    ...preStepSummaryDetails(t, counterpartyName, methodLabel),
    ...wizard.summaryDetails,
  ];
  const provider = wizard.fields.provider;
  return (
    <RampWizardShell
      steps={[...preSteps, ...displaySteps(wizard, t)]}
      stepIndex={preSteps.length + wizard.stepIndex}
      footerHint={frame.footerHint}
      onCancel={frame.onCancel}
      cancelLabel={frame.cancelLabel}
      confirmCancel={frame.confirmCancel}
      completionTitle={frame.completionTitle}
      primaryDisabled={frame.primaryDisabled}
      primaryLabel={onrampPrimaryLabel(wizard, frame.verificationPending, frame.verificationUrl, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={onrampPrimaryAction(wizard, frame.verificationUrl)}
      onSecondary={wizard.handleSecondary}
      counterpartyDialog={null}
      summary={provider === null ? undefined : <WizardSummaryList details={summaryDetails} />}
      summaryTrigger={
        provider === null ? undefined : <ProviderSummaryTrigger provider={provider} />
      }
      header={
        frame.showInlineStatus ? (
          <RampStatusInline
            direction="onramp"
            hosted={frame.hostedStage}
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
      hidePrimary={frame.hidePrimary}
    >
      <OnrampStepContent wizard={wizard} contact={contact} />
    </RampWizardShell>
  );
}
