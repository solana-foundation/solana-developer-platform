"use client";

import { CLUSTER_BY_SDP_ENVIRONMENT, type PaymentsDashboardWallet } from "@sdp/types";
import { useDashboardWorkspace } from "@/contexts/dashboard-workspace-context";
import { useTranslations } from "@/i18n/provider";
import { BatchSendStepContent } from "./components/batch-send-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type BatchSendWizard, useBatchSendWizard } from "./hooks/use-batch-send-wizard";

interface BatchSendRailProps {
  wallets: PaymentsDashboardWallet[];
  walletsError: string | null;
  issuedTokenSymbolsByMint: Record<string, string>;
  onExit: () => void;
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
      return t("DashboardPayments.batchSend.reviewPayments");
  }
}

export function BatchSendRail({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  onExit,
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
  const finished = Boolean(wizard.batchResult);
  // As with a single payment, the review step shows the outcome once sent and the progress
  // names that moment as a third step.
  const steps = [
    ...wizard.steps,
    {
      label: t("DashboardPayments.payForm.sent"),
      title: t("DashboardPayments.batchSend.resultSubmitted"),
    },
  ];

  return (
    <RampWizardShell
      steps={steps}
      stepIndex={finished ? wizard.stepIndex + 1 : wizard.stepIndex}
      prominentTitle={wizard.isLastStep && !finished}
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={batchPrimaryLabel(wizard, t)}
      secondaryDisabled={wizard.submitting}
      hideSecondary={finished}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.stepIndex === 0 ? wizard.handleSecondary : wizard.handleBack}
      onCancel={finished || wizard.submitting ? undefined : onExit}
      footerHint={
        wizard.stepIndex === 0 && wizard.recipients.length === 0
          ? t("DashboardPayments.batchSend.addRowsHint")
          : undefined
      }
      counterpartyDialog={null}
    >
      <BatchSendStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
