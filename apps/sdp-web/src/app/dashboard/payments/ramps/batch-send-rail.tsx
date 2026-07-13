"use client";

import { CLUSTER_BY_SDP_ENVIRONMENT, type PaymentsDashboardWallet } from "@sdp/types";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { BatchSendStepContent } from "./components/batch-send-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type SendMode, SendModeToggle } from "./components/send-mode-toggle";
import { type BatchSendWizard, useBatchSendWizard } from "./hooks/use-batch-send-wizard";

interface BatchSendRailProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  onExit: () => void;
  sendMode: SendMode;
  onSendModeChange: (mode: SendMode) => void;
}

function batchPrimaryLabel(wizard: BatchSendWizard, t: ReturnType<typeof useTranslations>): string {
  switch (true) {
    case wizard.submitting:
      return t("DashboardPayments.submitting");
    case wizard.isLastStep && Boolean(wizard.batchResult):
      return t("DashboardPayments.counterparty.done");
    case wizard.isLastStep:
      return t("DashboardPayments.sendBatch");
    default:
      return t("DashboardPayments.reviewAction");
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
  const t = useTranslations();
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
      steps={wizard.steps}
      stepIndex={wizard.stepIndex}
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={batchPrimaryLabel(wizard, t)}
      secondaryLabel={t("DashboardPayments.counterparty.cancel")}
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
