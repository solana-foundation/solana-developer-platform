"use client";

import { OnchainSendStepContent } from "./components/onchain-send-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import {
  ONCHAIN_SEND_STEPS,
  type OnchainSendWizard,
  useOnchainSendWizard,
} from "./hooks/use-onchain-send-wizard";
import type { RailProps } from "./ramp-action-page";

function sendPrimaryLabel(wizard: OnchainSendWizard): string {
  switch (true) {
    case wizard.submitting:
      return "Submitting...";
    case wizard.isLastStep && Boolean(wizard.transferResult):
      return "Done";
    case wizard.isLastStep:
      return "Send transfer";
    default:
      return "Next";
  }
}

export function OnchainSendRail({
  wallets,
  walletsError,
  counterpartyId,
  counterpartyName,
  preSteps,
  onExit,
}: RailProps) {
  const wizard = useOnchainSendWizard({ wallets, walletsError, counterpartyId, onExit });

  return (
    <RampWizardShell
      steps={[...preSteps, ...ONCHAIN_SEND_STEPS]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={sendPrimaryLabel(wizard)}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
    >
      <OnchainSendStepContent wizard={wizard} counterpartyName={counterpartyName} />
    </RampWizardShell>
  );
}
