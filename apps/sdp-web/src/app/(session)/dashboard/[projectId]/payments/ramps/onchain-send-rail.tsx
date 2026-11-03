"use client";

import { assertNever } from "@sdp/types/payments";
import { WizardSummaryList } from "@/app/(session)/dashboard/[projectId]/payments/wizard-summary-list";
import { useTranslations } from "@/i18n/provider";
import { sendResultKind } from "./components/onchain-send-result-kind";
import {
  type OnchainSendContactControls,
  OnchainSendStepContent,
  type PrivateSendStatus,
} from "./components/onchain-send-step-content";
import { PayEmptyState } from "./components/pay-empty-state";
import { hasFundedWallet, payEmptyReason } from "./components/pay-readiness";
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
  // While a send runs the label stays and the button spins (`primaryLoading`), so it never
  // changes width or reads as a different action.
  switch (true) {
    case wizard.isLastStep && wizard.finished:
      return t("DashboardPayments.counterparty.done");
    case wizard.isLastStep:
      return t("DashboardPayments.sendTransfer");
    default:
      return t("DashboardPayments.payForm.continueToReview");
  }
}

/**
 * The final step's heading once the transfer has an outcome: what became of it, never a
 * success it has not had. The frame renders it in place of "Review transfer", so a finished
 * step has exactly one heading.
 */
function sendCompletionTitle(
  wizard: OnchainSendWizard,
  t: ReturnType<typeof useTranslations>
): string | undefined {
  if (wizard.transferResult === null) {
    return undefined;
  }
  const kind = sendResultKind(wizard.transferResult);
  switch (kind) {
    case "failed":
      return t("DashboardPayments.onchainSend.transferFailedTitle");
    case "sent":
      return t("DashboardPayments.onchainSend.transferSentTitle");
    case "fireblocksPending":
    case "fireblocksUnknown":
    case "pending":
      return t("DashboardPayments.onchainSend.transferSubmitted");
    default:
      return assertNever(kind);
  }
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
  counterpartiesResult,
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
  // Pay with nobody to pay, or nothing to pay with, is the empty state rather than a form that
  // cannot be completed. Only where the flow picks its own contact, only before it has moved
  // on, and only once the live wallets (with balances) are in, so a loading pass never shows it.
  const emptyReason =
    contact && wizard.stepIndex === 0 && !wizard.walletsLoading && wizard.liveWalletsError === null
      ? payEmptyReason(counterpartiesResult.data.length > 0, hasFundedWallet(wizard.liveWallets))
      : null;
  if (emptyReason !== null) {
    return <PayEmptyState reason={emptyReason} onExit={onCancel ?? onExit} />;
  }
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
      primaryLoading={wizard.submitting}
      primaryLabel={sendPrimaryLabel(wizard, t)}
      walletsError={wizard.liveWalletsError}
      onPrimary={() => void wizard.handlePrimary()}
      onSecondary={wizard.handleSecondary}
      onCancel={wizard.finished || wizard.submitting ? undefined : onCancel}
      // A sent or held transfer has nothing to go back to, and one in flight cannot be left;
      // while it runs the footer's left says what it is waiting on instead.
      hideSecondary={wizard.finished || wizard.submitting}
      footerHint={
        wizard.submitting ? t("DashboardPayments.onchainSend.sendingAndConfirming") : undefined
      }
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
