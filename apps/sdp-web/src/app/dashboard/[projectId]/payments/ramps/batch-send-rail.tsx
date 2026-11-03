"use client";

import type { PaymentsDashboardWallet } from "@sdp/types/payments";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types/well-known-tokens";
import { Button } from "@sdp/ui/button";
import Link from "next/link";
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
    case wizard.recovering:
      return t("DashboardPayments.batchSend.checkStatus");
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
  // A send whose outcome is unknown holds the batch: no Back, no Cancel.
  const locked = finished || wizard.recovering;
  // A result can be a refusal before signing, so the final step claims no send.
  const steps = [
    ...wizard.steps,
    {
      label: t("DashboardPayments.batchSend.resultStep"),
      title: "",
    },
  ];

  return (
    <RampWizardShell
      steps={steps}
      stepIndex={finished ? wizard.stepIndex + 1 : wizard.stepIndex}
      primaryDisabled={wizard.submitting || wizard.retrying || !wizard.canProceed}
      primaryLoading={wizard.submitting}
      primaryLabel={batchPrimaryLabel(wizard, t)}
      secondaryDisabled={wizard.submitting}
      hideSecondary={locked}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.stepIndex === 0 ? wizard.handleSecondary : wizard.handleBack}
      onCancel={locked || wizard.submitting ? undefined : onExit}
      footerHint={
        wizard.stepIndex === 0 && wizard.recipients.length === 0
          ? t("DashboardPayments.batchSend.addRowsHint")
          : undefined
      }
      footerActions={
        wizard.recovering ? (
          <Button asChild variant="outline">
            <Link href={wizard.transactionsHref}>
              {t("DashboardPayments.batchSend.viewTransactions")}
            </Link>
          </Button>
        ) : finished && wizard.failedRecipientCount > 0 ? (
          <Button
            type="button"
            variant="outline"
            loading={wizard.retrying}
            onClick={() => void wizard.retryFailedRecipients()}
          >
            {t("DashboardPayments.batchSend.retryFailedRecipients")}
          </Button>
        ) : null
      }
      counterpartyDialog={null}
    >
      <BatchSendStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
