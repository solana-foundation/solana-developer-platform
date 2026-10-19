"use client";

import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import { Button } from "@sdp/ui/button";
import { SendIcon } from "lucide-react";
import Link from "next/link";
import { WizardSummaryList } from "@/app/dashboard/[projectId]/payments/wizard-summary-list";
import { useTranslations } from "@/i18n/provider";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { InstructionActionButton } from "./components/instruction-action-button";
import { OfframpStepContent } from "./components/offramp-step-content";
import { ProviderSummaryTrigger } from "./components/provider-summary-trigger";
import { RampStatusInline } from "./components/ramp-status-panel";
import { RampWizardShell } from "./components/ramp-wizard-shell";
import { type OfframpWizard, useOfframpWizard } from "./hooks/use-offramp-wizard";
import type { RailProps } from "./ramp-action-page";
import { getRampTransferState } from "./ramp-transfer-state";
import { preStepSummaryDetails } from "./wizard-summary";

type Translate = ReturnType<typeof useTranslations>;

function offrampPrimaryLabel(wizard: OfframpWizard, t: Translate): string {
  switch (true) {
    case wizard.hostedQuoteLoading:
      return t("DashboardPayments.processing");
    case wizard.isLastStep:
      return t("DashboardPayments.counterparty.done");
    default:
      return t("DashboardPayments.counterparty.next");
  }
}

/** The final step's heading once the payout reached an outcome worth naming. */
function offrampCompletionTitle(wizard: OfframpWizard, t: Translate): string | undefined {
  if (wizard.transferStatus?.status === "completed") {
    return t("DashboardPayments.ramps.payoutComplete");
  }
  return undefined;
}

/** Whether the title row carries the polled transfer status. */
function showOfframpInlineStatus(wizard: OfframpWizard, hosted: boolean): boolean {
  if (!wizard.onTransactionStage) {
    return false;
  }
  return hosted || wizard.depositTarget !== null;
}

type OfframpFooterAction =
  | { kind: "transaction" }
  | { kind: "send"; depositTarget: NonNullable<OfframpWizard["depositTarget"]> };

/** The one action the final step offers, in precedence order. */
function offrampFooterAction(wizard: OfframpWizard): OfframpFooterAction | null {
  const transfer = wizard.transferStatus;
  if (transfer !== undefined && getRampTransferState(transfer.status).terminal) {
    return { kind: "transaction" };
  }
  return wizard.depositTarget === null
    ? null
    : { kind: "send", depositTarget: wizard.depositTarget };
}

function OfframpFooterActionButton({
  action,
  wizard,
}: {
  action: OfframpFooterAction;
  wizard: OfframpWizard;
}) {
  const t = useTranslations();
  const href = useProjectHref();
  switch (action.kind) {
    case "transaction":
      return (
        <Button asChild type="button">
          <Link href={href(`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`)}>
            {t("DashboardPayments.goToTransaction")}
          </Link>
        </Button>
      );
    case "send":
      return (
        <InstructionActionButton
          variant="default"
          size="default"
          action={{
            loading: wizard.onchainSendLoading,
            succeeded: wizard.onchainSendResult !== null,
            disabled: !wizard.canSendOnchain,
            onClick: () => void wizard.sendCryptoToDeposit(),
            icon: <SendIcon />,
            idleLabel: t("DashboardPayments.ramps.sendCrypto", {
              amount: action.depositTarget.amount,
              token: getCryptoRailAssetLabel(wizard.selectedRampPair.assetRail),
            }),
            busyLabel: t("DashboardPayments.ramps.sending"),
            doneLabel: t("DashboardPayments.ramps.transferSubmitted"),
          }}
        />
      );
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

  const transferState =
    wizard.transferStatus === undefined ? null : getRampTransferState(wizard.transferStatus.status);
  const liveTransferState = wizard.onTransactionStage ? transferState : null;
  const cancelable = liveTransferState?.cancelable === true;
  const hosted = wizard.onTransactionStage && wizard.quote?.deliveryMode === "hosted";
  const footerAction = offrampFooterAction(wizard);
  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      completionTitle={offrampCompletionTitle(wizard, t)}
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        !wizard.canProceed ||
        (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={offrampPrimaryLabel(wizard, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={wizard.isLastStep ? wizard.finish : () => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      counterpartyDialog={null}
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
        showOfframpInlineStatus(wizard, hosted) ? (
          <RampStatusInline direction="offramp" hosted={hosted} transfer={wizard.transferStatus} />
        ) : undefined
      }
      secondaryLabel={cancelable ? t("DashboardPayments.counterparty.cancel") : undefined}
      confirmSecondary={cancelable}
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading || wizard.quoteInFlight}
      hideSecondary={liveTransferState !== null && !liveTransferState.cancelable}
      footerActions={
        footerAction === null ? undefined : (
          <OfframpFooterActionButton action={footerAction} wizard={wizard} />
        )
      }
      hidePrimary={wizard.currentStepId === "COMPLETE"}
    >
      <OfframpStepContent wizard={wizard} />
    </RampWizardShell>
  );
}
