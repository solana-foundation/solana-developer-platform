"use client";

import { getCryptoRailAssetLabel } from "@sdp/types";
import { SendIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { WizardSummaryList } from "../wizard-summary-list";
import { InstructionActionButton } from "./components/manual-instructions-quote";
import { OfframpStepContent } from "./components/offramp-step-content";
import { ProviderSummaryTrigger } from "./components/provider-summary-trigger";
import { RampStatusInline } from "./components/ramp-status-panel";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type OfframpWizard, useOfframpWizard } from "./hooks/use-offramp-wizard";
import type { RailProps } from "./ramp-action-page";
import { getRampTransferState } from "./ramp-transfer-state";
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
  enabledRampProviders,
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
    enabledRampProviders,
    rampProviderAccess,
    counterpartiesResult,
    selectedCounterparty,
    initialCounterpartyId: counterpartyId,
    onExit,
  });

  const transferState = getRampTransferState(wizard.transferStatus?.status);
  const hostedStage = wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted";
  const showInlineStatus =
    wizard.onTransactionStage && (hostedStage || Boolean(wizard.depositTarget));
  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      completionTitle={
        wizard.transferStatus?.status === "completed"
          ? t("DashboardPayments.ramps.payoutComplete")
          : undefined
      }
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
        wizard.fields.provider === null ? undefined : (
          <WizardSummaryList
            details={[
              ...preStepSummaryDetails(t, counterpartyName, methodLabel),
              ...wizard.summaryDetails,
            ]}
          />
        )
      }
      summaryTrigger={
        wizard.fields.provider === null ? undefined : (
          <ProviderSummaryTrigger provider={wizard.fields.provider} />
        )
      }
      header={
        showInlineStatus ? (
          <RampStatusInline
            direction="offramp"
            hosted={hostedStage}
            transfer={wizard.transferStatus}
          />
        ) : undefined
      }
      secondaryLabel={
        wizard.onTransactionStage && transferState.cancelable
          ? t("DashboardPayments.counterparty.cancel")
          : undefined
      }
      confirmSecondary={wizard.onTransactionStage && transferState.cancelable}
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading}
      hideSecondary={wizard.onTransactionStage && !transferState.cancelable}
      footerActions={
        transferState.terminal ? (
          <Button asChild type="button">
            <Link href={`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`}>
              {t("DashboardPayments.goToTransaction")}
            </Link>
          </Button>
        ) : wizard.depositTarget ? (
          <InstructionActionButton
            variant="default"
            size="default"
            action={{
              loading: wizard.onchainSendLoading,
              succeeded: wizard.onchainSendResult !== null,
              disabled: !wizard.canSendOnchain || wizard.quoteExpired,
              onClick: () => void wizard.sendCryptoToDeposit(),
              icon: <SendIcon />,
              idleLabel: wizard.quoteExpired
                ? t("DashboardPayments.ramps.quoteExpired")
                : t("DashboardPayments.ramps.sendCrypto", {
                    amount: wizard.depositTarget.amount,
                    token: getCryptoRailAssetLabel(wizard.selectedRampPair.assetRail),
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
