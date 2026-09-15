"use client";

import { getCryptoRailAssetLabel } from "@sdp/types";
import { SendIcon } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/i18n/provider";
import { openExternalRampUrl } from "@/lib/trusted-ramp-destinations";
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

type Translate = ReturnType<typeof useTranslations>;

function offrampPrimaryLabel(
  wizard: OfframpWizard,
  verificationPending: boolean,
  verificationUrl: string | undefined,
  t: Translate
): string {
  switch (true) {
    case wizard.hostedQuoteLoading:
      return t("DashboardPayments.processing");
    case verificationPending:
      return t("DashboardPayments.verificationPending");
    case verificationUrl !== undefined:
      return t("DashboardPayments.completeVerification");
    case wizard.currentStepId === "REQUIREMENTS" && wizard.pendingAgreements !== null:
      return t("DashboardPayments.bvnk.acceptAgreements");
    case wizard.isLastStep:
      return t("DashboardPayments.counterparty.done");
    default:
      return t("DashboardPayments.counterparty.next");
  }
}

function offrampPrimaryAction(
  wizard: OfframpWizard,
  verificationUrl: string | undefined
): () => void {
  switch (true) {
    case verificationUrl !== undefined:
      return () => openExternalRampUrl(verificationUrl);
    case wizard.isLastStep:
      return wizard.finish;
    default:
      return () => void wizard.handlePrimary();
  }
}

/** The final step's heading once the payout reached an outcome worth naming. */
function offrampCompletionTitle(wizard: OfframpWizard, t: Translate): string | undefined {
  if (wizard.transferStatus?.status === "completed") {
    return t("DashboardPayments.ramps.payoutComplete");
  }
  if (wizard.heldApprovalRequestId !== null) {
    return t("DashboardPayments.ramps.transferApprovalPending");
  }
  return undefined;
}

/**
 * Whether the title row carries the polled transfer status. A held send hides
 * it: the heading already says the send waits for approval, and the row still
 * reads `awaiting_payment`, which would ask for a send that is already queued.
 */
function showOfframpInlineStatus(wizard: OfframpWizard, hosted: boolean): boolean {
  if (!wizard.onTransactionStage || wizard.heldApprovalRequestId !== null) {
    return false;
  }
  return hosted || wizard.depositTarget !== null;
}

type OfframpFooterAction =
  | { kind: "transaction" }
  | { kind: "approval"; approvalRequestId: string }
  | { kind: "send"; depositTarget: NonNullable<OfframpWizard["depositTarget"]> };

/** The one action the final step offers, in precedence order. */
function offrampFooterAction(wizard: OfframpWizard): OfframpFooterAction | null {
  const transfer = wizard.transferStatus;
  if (transfer !== undefined && getRampTransferState(transfer.status).terminal) {
    return { kind: "transaction" };
  }
  if (wizard.heldApprovalRequestId !== null) {
    return { kind: "approval", approvalRequestId: wizard.heldApprovalRequestId };
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
  switch (action.kind) {
    case "transaction":
      return (
        <Button asChild type="button">
          <Link href={`/dashboard/payments/counterparty/${wizard.fields.counterpartyId}`}>
            {t("DashboardPayments.goToTransaction")}
          </Link>
        </Button>
      );
    case "approval":
      return (
        <Button asChild type="button">
          <Link href={`/dashboard/approvals/${encodeURIComponent(action.approvalRequestId)}`}>
            {t("DashboardPayments.onchainSend.viewApprovalRequest")}
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
            disabled: !wizard.canSendOnchain || wizard.quoteExpired,
            onClick: () => void wizard.sendCryptoToDeposit(),
            icon: <SendIcon />,
            idleLabel: wizard.quoteExpired
              ? t("DashboardPayments.ramps.quoteExpired")
              : t("DashboardPayments.ramps.sendCrypto", {
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
  const onOnboardingStep =
    wizard.currentStepId === "COMPLETE" || wizard.currentStepId === "REQUIREMENTS";
  const verificationUrl =
    onOnboardingStep && wizard.onboarding?.status === "customer_verification_required"
      ? wizard.onboarding.verificationUrl
      : undefined;
  const verificationPending =
    onOnboardingStep &&
    (wizard.onboarding?.status === "customer_verifying" ||
      wizard.onboarding?.status === "customer_funding_account_provisioning" ||
      wizard.onboarding?.status === "funding_account_provisioning");
  return (
    <RampWizardShell
      steps={[...preSteps, ...wizard.steps]}
      stepIndex={preSteps.length + wizard.stepIndex}
      completionTitle={offrampCompletionTitle(wizard, t)}
      primaryDisabled={
        wizard.hostedQuoteLoading ||
        verificationPending ||
        !wizard.canProceed ||
        (wizard.currentStepId === "WALLET" && wizard.walletsLoading)
      }
      primaryLabel={offrampPrimaryLabel(wizard, verificationPending, verificationUrl, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={offrampPrimaryAction(wizard, verificationUrl)}
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
      secondaryDisabled={wizard.isCanceling || wizard.hostedQuoteLoading}
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
