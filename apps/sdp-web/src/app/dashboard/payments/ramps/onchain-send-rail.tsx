"use client";

import { useTranslations } from "@/i18n/provider";
import { WizardSummaryList } from "../wizard-summary-list";
import { OnchainSendStepContent } from "./components/onchain-send-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import {
  getOnchainSendSteps,
  type OnchainSendWizard,
  useOnchainSendWizard,
} from "./hooks/use-onchain-send-wizard";
import type { RailProps } from "./ramp-action-page";
import { preStepSummaryDetails } from "./wizard-summary";

function sendPrimaryLabel(
  wizard: OnchainSendWizard,
  t: ReturnType<typeof useTranslations>
): string {
  switch (true) {
    case wizard.submitting:
      return t("DashboardPayments.submitting");
    case wizard.isLastStep && wizard.finished:
      return t("DashboardPayments.counterparty.done");
    case wizard.isLastStep:
      return t("DashboardPayments.sendTransfer");
    default:
      return t("DashboardPayments.counterparty.next");
  }
}

/**
 * The final step's heading once the transfer has an outcome. The frame renders
 * it in place of "Review transfer", so a finished step has exactly one heading.
 */
function sendCompletionTitle(
  wizard: OnchainSendWizard,
  t: ReturnType<typeof useTranslations>
): string | undefined {
  if (wizard.heldApprovalRequestId !== null) {
    return t("DashboardPayments.onchainSend.approvalPendingTitle");
  }
  if (wizard.transferResult !== null) {
    return t("DashboardPayments.onchainSend.transferSubmitted");
  }
  return undefined;
}

export function OnchainSendRail({
  wallets,
  walletsError,
  issuedTokenSymbolsByMint,
  counterpartyId,
  counterpartyName,
  methodLabel,
  preSteps,
  onExit,
}: RailProps) {
  const t = useTranslations();
  const wizard = useOnchainSendWizard({
    wallets,
    walletsError,
    issuedTokenSymbolsByMint,
    counterpartyId,
    onExit,
  });
  return (
    <RampWizardShell
      steps={[...preSteps, ...getOnchainSendSteps(t)]}
      stepIndex={preSteps.length + wizard.stepIndex}
      completionTitle={sendCompletionTitle(wizard, t)}
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={sendPrimaryLabel(wizard, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      // A sent or held transfer has nothing to go back to.
      hideSecondary={wizard.finished}
      counterpartyDialog={null}
      summary={
        <WizardSummaryList
          details={[
            ...preStepSummaryDetails(t, counterpartyName, methodLabel),
            ...wizard.summaryDetails,
          ]}
        />
      }
    >
      <OnchainSendStepContent wizard={wizard} counterpartyName={counterpartyName} />
    </RampWizardShell>
  );
}
