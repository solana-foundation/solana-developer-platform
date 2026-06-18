"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { OfframpStepContent } from "./components/offramp-step-content";
import { PoweredByRampProvider, RampWizardShell } from "./components/ramp-wizard-shell";
import { type OfframpWizard, useOfframpWizard } from "./hooks/use-offramp-wizard";
import { isTerminalRampTransferStatus } from "./hooks/use-ramp-wizard";
import type { RailProps } from "./ramp-action-page";

function offrampPrimaryLabel(wizard: OfframpWizard): string {
  switch (true) {
    case wizard.hostedQuoteLoading:
      return "Processing";
    case wizard.isLastStep:
      return "Done";
    default:
      return "Next";
  }
}

export function OfframpRail({
  wallets,
  walletsError,
  enabledRampProviders,
  counterpartiesResult,
  counterpartyId,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOfframpWizard({
    wallets,
    walletsError,
    enabledRampProviders,
    counterpartiesResult,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  const transferTerminal = wizard.transferStatus
    ? isTerminalRampTransferStatus(wizard.transferStatus.status)
    : false;

  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        !wizard.canProceed ||
        (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={offrampPrimaryLabel(wizard)}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
      header={
        wizard.fields.provider &&
        (wizard.currentStepId === "REQUIREMENTS" || wizard.currentStepId === "COMPLETE") ? (
          <PoweredByRampProvider provider={wizard.fields.provider} />
        ) : null
      }
      secondaryLabel={wizard.onTransactionStage ? "Cancel" : undefined}
      footerActions={
        transferTerminal ? (
          <Button asChild type="button">
            <Link href={`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`}>
              Go to transaction
            </Link>
          </Button>
        ) : null
      }
      hidePrimary={wizard.currentStepId === "COMPLETE"}
    >
      <OfframpStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
