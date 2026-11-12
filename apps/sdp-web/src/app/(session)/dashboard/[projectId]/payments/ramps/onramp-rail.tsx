"use client";

import type { PaymentRampQuote, PaymentTransferSummary } from "@sdp/types/payments";
import { Button } from "@sdp/ui/button";
import Link from "next/link";
import { WizardSummaryList } from "@/app/(session)/dashboard/[projectId]/payments/wizard-summary-list";
import { useTranslations } from "@/i18n/provider";
import { getRampProviderLabel } from "@/lib/ramps";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";
import { useProjectHref } from "@/lib/use-dashboard-project";
import type { ContactControls } from "./components/contact-combobox";
import { OnrampStepContent } from "./components/onramp-step-content";
import { ProviderSummaryTrigger } from "./components/provider-summary-trigger";
import { RampStatusInline } from "./components/ramp-status-panel";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type OnrampWizard, useOnrampWizard } from "./hooks/use-onramp-wizard";
import type { RailProps } from "./ramp-action-page";
import { getRampTransferState } from "./ramp-transfer-state";
import { preStepSummaryDetails } from "./wizard-summary";

/**
 * Whether the footer's primary button simulates the deposit's pay-in: on the provider step of a
 * sandbox deposit still waiting for its money, when no verification is due first.
 */
function simulatesDeposit(
  wizard: Pick<OnrampWizard, "currentStepId" | "simulateAvailable">,
  verificationUrl: string | undefined
): boolean {
  return (
    wizard.currentStepId === "PROVIDER" && verificationUrl === undefined && wizard.simulateAvailable
  );
}

function onrampPrimaryLabel(
  wizard: OnrampWizard,
  verificationPending: boolean,
  verificationUrl: string | undefined,
  t: ReturnType<typeof useTranslations>
): string {
  switch (true) {
    case simulatesDeposit(wizard, verificationUrl):
      return wizard.quoteSimulationSucceeded
        ? t("DashboardPayments.ramps.depositSimulated")
        : t("DashboardPayments.ramps.simulateDeposit");
    case verificationPending:
      return t("DashboardPayments.verificationPending");
    case verificationUrl !== undefined:
      return t("DashboardPayments.completeVerification");
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
    case simulatesDeposit(wizard, verificationUrl):
      return () => void wizard.simulateCurrentQuote();
    case wizard.isLastStep:
      return wizard.finish;
    default:
      return () => void wizard.handlePrimary();
  }
}

/**
 * The wizard's steps as the frame shows them: the provider's name in "What {provider} needs"
 * on its requirements step. The memo is SDP's own record of the deposit, so it stays "Memo",
 * as on the off-ramp, whatever the provider asks for.
 */
function displaySteps(wizard: OnrampWizard, t: ReturnType<typeof useTranslations>) {
  const provider = wizard.fields.provider ? getRampProviderLabel(wizard.fields.provider) : null;
  const needsTitle = provider
    ? t("DashboardPayments.ramps.whatProviderNeeds", { provider })
    : undefined;
  return wizard.steps.map((step) => {
    if (step.id === "REQUIREMENTS") return { ...step, title: needsTitle ?? step.title };
    if (step.id === "MEMO") return { ...step, label: t("DashboardPayments.ramps.memoStep") };
    return step;
  });
}

/** The wizard state the frame reads. */
export type OnrampFrameWizard = Pick<
  OnrampWizard,
  | "canProceed"
  | "currentStepId"
  | "handleSecondary"
  | "hostedQuoteLoading"
  | "isCanceling"
  | "onTransactionStage"
  | "onboarding"
  | "quoteSimulationLoading"
  | "quoteSimulationSucceeded"
  | "simulateAvailable"
  | "walletsLoading"
> & {
  fields: Pick<OnrampWizard["fields"], "provider">;
  quote: Pick<PaymentRampQuote, "deliveryMode"> | null;
  transferStatus: Pick<PaymentTransferSummary, "status"> | undefined;
};

/**
 * What the frame shows for where the deposit is: the verification the provider still wants,
 * whether the transfer can still be canceled, and the hints, labels and gates that follow.
 */
export function onrampFrameState(
  wizard: OnrampFrameWizard,
  onCancel: (() => void) | undefined,
  t: ReturnType<typeof useTranslations>
) {
  // The provider's onboarding answers on the provider step, where the quote waits for it.
  const onboarding = wizard.currentStepId === "PROVIDER" ? wizard.onboarding : null;
  const verificationUrl =
    onboarding?.status === "customer_verification_required"
      ? onboarding.verificationUrl
      : undefined;
  const verificationPending = onboarding?.status === "customer_verifying";
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
    // A simulated pay-in and a cancel each change where the deposit goes, so neither starts while the other runs.
    cancelDisabled: wizard.isCanceling || wizard.quoteSimulationLoading,
    completionTitle:
      wizard.transferStatus?.status === "completed"
        ? t("DashboardPayments.ramps.depositComplete")
        : undefined,
    primaryDisabled: simulatesDeposit(wizard, verificationUrl)
      ? wizard.quoteSimulationLoading || wizard.quoteSimulationSucceeded || wizard.isCanceling
      : wizard.hostedQuoteLoading ||
        verificationPending ||
        !wizard.canProceed ||
        (wizard.currentStepId === "DEPOSIT" && wizard.walletsLoading),
    // The primary keeps its words while its request runs: the simulated pay-in, or the hosted
    // quote that opens the provider's checkout.
    primaryLoading: simulatesDeposit(wizard, verificationUrl)
      ? wizard.quoteSimulationLoading
      : wizard.hostedQuoteLoading,
    hidePrimary:
      wizard.currentStepId === "PROVIDER" &&
      !verificationUrl &&
      !simulatesDeposit(wizard, verificationUrl),
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
  const projectHref = useProjectHref();
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
      cancelDisabled={frame.cancelDisabled}
      completionTitle={frame.completionTitle}
      primaryDisabled={frame.primaryDisabled}
      primaryLoading={frame.primaryLoading}
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
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading || wizard.quoteInFlight}
      // Once the quote exists there is nothing to go back to; the footer's Cancel deposit
      // (confirmed) is the way out while the transfer can still be canceled.
      hideSecondary={wizard.onTransactionStage}
      footerActions={
        wizard.quoteTransferId !== null && wizard.onTransactionStage ? (
          // Second to the simulation while that is on offer.
          <Button
            asChild
            type="button"
            variant={simulatesDeposit(wizard, frame.verificationUrl) ? "outline" : "default"}
          >
            <Link
              href={projectHref(
                `/dashboard/payments/transactions?module=payments&search=${encodeURIComponent(wizard.quoteTransferId)}`
              )}
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
