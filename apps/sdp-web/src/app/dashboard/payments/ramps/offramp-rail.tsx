"use client";

import { SendIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { toRampCryptoToken } from "@/lib/ramps";
import { WizardSummaryList } from "../wizard-summary-list";
import { InstructionActionButton } from "./components/manual-instructions-quote";
import { OfframpStepContent } from "./components/offramp-step-content";
import { RampStatusInline } from "./components/ramp-status-panel";
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
  const hostedStage = wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted";
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
      header={
        hostedStage && wizard.transferStatus?.status !== "completed" ? (
          <RampStatusInline direction="offramp" hosted transfer={wizard.transferStatus} />
        ) : undefined
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
        ) : wizard.depositTarget ? (
          <InstructionActionButton
            action={{
              loading: wizard.onchainSendLoading,
              succeeded: wizard.onchainSendResult !== null,
              disabled: !wizard.canSendOnchain,
              onClick: () => void wizard.sendCryptoToDeposit(),
              icon: <SendIcon />,
              idleLabel: t("DashboardPayments.ramps.sendCrypto", {
                amount: wizard.depositTarget.amount,
                token: toRampCryptoToken(wizard.selectedRampPair.assetRail).toUpperCase(),
              }),
              busyLabel: t("DashboardPayments.ramps.sending"),
              doneLabel: t("DashboardPayments.ramps.transferSubmitted"),
            }}
          />
        ) : null
      }
      hidePrimary={wizard.currentStepId === "COMPLETE"}
    >
      <OfframpStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
