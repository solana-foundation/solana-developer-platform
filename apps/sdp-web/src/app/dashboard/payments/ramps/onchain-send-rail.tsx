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
    case wizard.isLastStep && Boolean(wizard.transferResult):
      return t("DashboardPayments.counterparty.done");
    case wizard.isLastStep:
      return t("DashboardPayments.sendTransfer");
    default:
      return t("DashboardPayments.counterparty.next");
  }
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
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={sendPrimaryLabel(wizard, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialogOpen={false}
      setCounterpartyDialogOpen={() => {}}
      onCounterpartyCreated={() => {}}
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
