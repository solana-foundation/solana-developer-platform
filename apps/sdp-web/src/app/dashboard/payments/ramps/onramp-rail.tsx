"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";
import { WizardSummaryList } from "../wizard-summary-list";
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
    default:
      return t("DashboardPayments.counterparty.next");
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
}: RailProps) {
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
    (wizard.onboarding?.status === "customer_verifying" ||
      wizard.onboarding?.status === "customer_funding_account_provisioning" ||
      wizard.onboarding?.status === "funding_account_provisioning");

  const summaryDetails = [
    ...preStepSummaryDetails(t, counterpartyName, methodLabel),
    ...wizard.summaryDetails,
  ];
  const hostedStage = wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted";
  const showInlineStatus = wizard.onTransactionStage && Boolean(wizard.quote);
  const transferState =
    wizard.transferStatus === undefined ? null : getRampTransferState(wizard.transferStatus.status);
  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
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
      secondaryLabel={
        wizard.onTransactionStage && transferState !== null && transferState.cancelable
          ? t("DashboardPayments.counterparty.cancel")
          : undefined
      }
      confirmSecondary={
        wizard.onTransactionStage && transferState !== null && transferState.cancelable
      }
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading}
      hideSecondary={
        wizard.onTransactionStage && transferState !== null && !transferState.cancelable
      }
      footerActions={
        transferState !== null && transferState.terminal ? (
          <Button asChild type="button">
            <Link href={`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`}>
              {t("DashboardPayments.goToTransaction")}
            </Link>
          </Button>
        ) : null
      }
      hidePrimary={wizard.currentStepId === "PROVIDER" && !verificationUrl}
    >
      <OnrampStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
