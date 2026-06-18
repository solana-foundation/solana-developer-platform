"use client";

import { OnchainReceiveStepContent } from "./components/onchain-receive-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { ONCHAIN_RECEIVE_STEPS, useOnchainReceiveWizard } from "./hooks/use-onchain-receive-wizard";
import type { RailProps } from "./ramp-action-page";

export function OnchainReceiveRail({
  wallets,
  walletsError,
  counterpartyId,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOnchainReceiveWizard({ wallets, walletsError, counterpartyId, onExit });

  return (
    <RampWizardShell
      steps={[...preSteps, ...ONCHAIN_RECEIVE_STEPS]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={
        !wizard.canProceed || (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={wizard.isLastStep ? "Done" : "Next"}
      walletsError={wizard.liveWalletsError}
      onPrimary={wizard.handlePrimary}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
    >
      <OnchainReceiveStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
