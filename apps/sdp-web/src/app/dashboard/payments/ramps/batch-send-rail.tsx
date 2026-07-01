"use client";

import { CLUSTER_BY_SDP_ENVIRONMENT, type PaymentsDashboardWallet } from "@sdp/types";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { BatchSendStepContent } from "./components/batch-send-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type SendMode, SendModeToggle } from "./components/send-mode-toggle";
import {
  BATCH_SEND_STEPS,
  type BatchSendWizard,
  useBatchSendWizard,
} from "./hooks/use-batch-send-wizard";

interface BatchSendRailProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  onExit: () => void;
  sendMode: SendMode;
  onSendModeChange: (mode: SendMode) => void;
}

function batchPrimaryLabel(wizard: BatchSendWizard): string {
  switch (true) {
    case wizard.submitting:
      return "Submitting...";
    case wizard.isLastStep && Boolean(wizard.batchResult):
      return "Done";
    case wizard.isLastStep:
      return "Send batch";
    default:
      return "Review";
  }
}

export function BatchSendRail({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  onExit,
  sendMode,
  onSendModeChange,
}: BatchSendRailProps) {
  const { sdpEnvironment } = useDashboardWorkspace();
  const wizard = useBatchSendWizard({
    wallets,
    walletsError,
    issuedTokenSymbolsByMint,
    cluster: CLUSTER_BY_SDP_ENVIRONMENT[sdpEnvironment],
    onExit,
  });

  return (
    <RampWizardShell
      steps={BATCH_SEND_STEPS}
      stepIndex={wizard.stepIndex}
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={batchPrimaryLabel(wizard)}
      secondaryLabel="Cancel"
      confirmSecondary={wizard.isLastStep && !wizard.batchResult}
      secondaryDisabled={wizard.submitting}
      hideSecondary={Boolean(wizard.batchResult)}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
      header={
        wizard.stepIndex === 0 ? (
          <SendModeToggle value={sendMode} onChange={onSendModeChange} />
        ) : undefined
      }
    >
      <BatchSendStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
