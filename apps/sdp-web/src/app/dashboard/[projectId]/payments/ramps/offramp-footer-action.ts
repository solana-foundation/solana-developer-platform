import type {
  PaymentsDashboardWallet,
  PaymentTransferSummary,
  RampCryptoDeposit,
} from "@sdp/types/payments";
import { getRampTransferState } from "@/app/dashboard/[projectId]/payments/ramps/ramp-transfer-state";
import type { SelectedRampPair } from "@/lib/ramps";

/** What the off-ramp's final step reads from either wizard. */
export interface OfframpFinalStepWizard {
  quoteTransferId: string | null;
  transferStatus: PaymentTransferSummary | undefined;
  depositTarget: RampCryptoDeposit | null;
  selectedRampPair: SelectedRampPair;
  selectedWallet: Pick<PaymentsDashboardWallet, "label" | "publicKey"> | null;
  canSendOnchain: boolean;
  onchainSendLoading: boolean;
  onchainSendResult: PaymentTransferSummary | null;
  onchainSendError: string | null;
  sendCryptoToDeposit: () => Promise<void>;
  startOver: (stepId: "WITHDRAW") => void;
}

export type OfframpFooterAction =
  | { kind: "transaction"; transferId: string }
  | { kind: "send"; depositTarget: RampCryptoDeposit };

/** The one action the final step offers: the finished transaction, or sending the deposit. */
export function offrampFooterAction(wizard: OfframpFinalStepWizard): OfframpFooterAction | null {
  const transfer = wizard.transferStatus;
  if (
    transfer !== undefined &&
    getRampTransferState(transfer.status).terminal &&
    wizard.quoteTransferId !== null
  ) {
    return { kind: "transaction", transferId: wizard.quoteTransferId };
  }
  return wizard.depositTarget === null
    ? null
    : { kind: "send", depositTarget: wizard.depositTarget };
}
