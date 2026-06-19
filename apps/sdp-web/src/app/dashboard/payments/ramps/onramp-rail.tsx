"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { OnrampStepContent } from "./components/onramp-step-content";
import { PoweredByRampProvider, RampWizardShell } from "./components/ramp-wizard-shell";
import { type OnrampWizard, useOnrampWizard } from "./hooks/use-onramp-wizard";
import { isTerminalRampTransferStatus } from "./hooks/use-ramp-wizard";
import type { RailProps } from "./ramp-action-page";

function onrampPrimaryLabel(
  wizard: OnrampWizard,
  verificationPending: boolean,
  verificationUrl: string | undefined
): string {
  switch (true) {
    case wizard.hostedQuoteLoading:
      return "Processing";
    case verificationPending:
      return "Verification pending";
    case verificationUrl !== undefined:
      return "Complete Verification";
    default:
      return "Next";
  }
}

function onrampPrimaryAction(
  wizard: OnrampWizard,
  verificationUrl: string | undefined
): () => void {
  switch (true) {
    case verificationUrl !== undefined:
      return () => window.open(verificationUrl, "_blank", "noopener");
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
  counterpartiesResult,
  counterpartyId,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOnrampWizard({
    wallets,
    walletsError,
    enabledRampProviders,
    counterpartiesResult,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  const verificationUrl =
    wizard.currentStepId === "PROVIDER" &&
    wizard.onboarding?.status === "customer_verification_required"
      ? wizard.onboarding.verificationUrl
      : undefined;

  const verificationPending =
    wizard.currentStepId === "PROVIDER" &&
    (wizard.onboarding?.status === "customer_verifying" ||
      wizard.onboarding?.status === "funding_account_provisioning");

  const transferTerminal = wizard.transferStatus
    ? isTerminalRampTransferStatus(wizard.transferStatus.status)
    : false;

  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        verificationPending ||
        !wizard.canProceed ||
        (wizard.currentStepId === "DEPOSIT" && wizard.walletsLoading)
      }
      primaryLabel={onrampPrimaryLabel(wizard, verificationPending, verificationUrl)}
      walletsError={wizard.liveWalletsError}
      onPrimary={onrampPrimaryAction(wizard, verificationUrl)}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
      header={
        wizard.fields.provider &&
        (wizard.currentStepId === "REQUIREMENTS" || wizard.currentStepId === "PROVIDER") ? (
          <PoweredByRampProvider provider={wizard.fields.provider} />
        ) : null
      }
      secondaryLabel={wizard.onTransactionStage ? "Cancel" : undefined}
      confirmSecondary={wizard.onTransactionStage}
      secondaryDisabled={wizard.isCanceling}
      footerActions={
        transferTerminal ? (
          <Button asChild type="button">
            <Link href={`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`}>
              Go to transaction
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
