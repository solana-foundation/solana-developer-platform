"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { WizardSummaryList } from "../wizard-summary-list";
import { OfframpStepContent } from "./components/offramp-step-content";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type OfframpWizard, useOfframpWizard } from "./hooks/use-offramp-wizard";
import { isTerminalRampTransferStatus } from "./hooks/use-ramp-wizard";
import type { RailProps } from "./ramp-action-page";
import { preStepSummaryDetails } from "./wizard-summary";

function offrampPrimaryLabel(wizard: OfframpWizard, t: ReturnType<typeof useTranslations>): string {
  switch (true) {
    case wizard.hostedQuoteLoading:
      return t("DashboardPayments.processing");
    case wizard.isLastStep:
      return t("DashboardPayments.counterparty.done");
    default:
      return t("DashboardPayments.counterparty.next");
  }
}

export function OfframpRail({
  wallets,
  walletsError,
  rampProviderAccess,
  counterpartiesResult,
  selectedCounterparty,
  counterpartyId,
  counterpartyName,
  methodLabel,
  preSteps,
  onExit,
}: RailProps) {
  const t = useTranslations();
  const wizard = useOfframpWizard({
    wallets,
    walletsError,
    rampProviderAccess,
    counterpartiesResult,
    selectedCounterparty,
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
      primaryLabel={offrampPrimaryLabel(wizard, t)}
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
      secondaryLabel={
        wizard.onTransactionStage ? t("DashboardPayments.counterparty.cancel") : undefined
      }
      confirmSecondary={wizard.onTransactionStage}
      secondaryDisabled={wizard.isCanceling}
      footerActions={
        transferTerminal ? (
          <Button asChild type="button">
            <Link href={`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`}>
              {t("DashboardPayments.goToTransaction")}
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
