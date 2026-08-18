"use client";

import { useTranslations } from "@/i18n/provider";
import { WizardSummaryList } from "../wizard-summary-list";
import { OnchainReceiveStepContent } from "./components/onchain-receive-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { useOnchainReceiveWizard } from "./hooks/use-onchain-receive-wizard";
import type { RailProps } from "./ramp-action-page";
import { preStepSummaryDetails } from "./wizard-summary";

export function OnchainReceiveRail({
  wallets,
  walletsError,
  counterpartyId,
  counterpartyName,
  methodLabel,
  preSteps,
  onExit,
}: RailProps) {
  const t = useTranslations();
  const wizard = useOnchainReceiveWizard({ wallets, walletsError, counterpartyId, onExit });

  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      primaryDisabled={
        !wizard.canProceed || (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={
        wizard.isLastStep
          ? t("DashboardPayments.counterparty.done")
          : t("DashboardPayments.counterparty.next")
      }
      walletsError={wizard.liveWalletsError}
      onPrimary={wizard.handlePrimary}
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
      <OnchainReceiveStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
