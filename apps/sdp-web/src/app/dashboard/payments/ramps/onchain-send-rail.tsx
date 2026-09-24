"use client";

import { useTranslations } from "@/i18n/provider";
import { WizardSummaryList } from "../wizard-summary-list";
import {
  type OnchainSendContactControls,
  OnchainSendStepContent,
  type PrivateSendStatus,
} from "./components/onchain-send-step-content";
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
      return t("DashboardPayments.payForm.continueToReview");
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

export interface OnchainSendRailProps extends RailProps {
  /** The contact picker at the top of the details step; the contact is fixed without it. */
  contact?: OnchainSendContactControls;
  privateSend?: PrivateSendStatus | null;
  /** Switches to a bank payout through a provider, offered once a contact is picked. */
  onPayByBank?: () => void;
  /** Leaves the flow entirely (the footer's Cancel). */
  onCancel?: () => void;
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
  contact,
  privateSend,
  onPayByBank,
  onCancel,
}: OnchainSendRailProps) {
  const t = useTranslations();
  const wizard = useOnchainSendWizard({
    wallets,
    walletsError,
    issuedTokenSymbolsByMint,
    counterpartyId,
    onExit,
  });
  // The review step shows the outcome once sent; the progress names that moment as its own
  // step, so a finished payment reads "Step 3 of 3".
  const sentStep = {
    label: t("DashboardPayments.payForm.sent"),
    title: t("DashboardPayments.onchainSend.transferSubmitted"),
  };
  return (
    <RampWizardShell
      steps={[...preSteps, ...getOnchainSendSteps(t), sentStep]}
      stepIndex={preSteps.length + (wizard.finished ? wizard.stepIndex + 1 : wizard.stepIndex)}
      completionTitle={sendCompletionTitle(wizard, t)}
      primaryDisabled={wizard.submitting || !wizard.canProceed}
      primaryLabel={sendPrimaryLabel(wizard, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      onCancel={wizard.finished || wizard.submitting ? undefined : onCancel}
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
      <OnchainSendStepContent
        wizard={wizard}
        counterpartyName={counterpartyName}
        contact={contact}
        privateSend={privateSend}
        onPayByBank={onPayByBank}
      />
    </RampWizardShell>
  );
}
