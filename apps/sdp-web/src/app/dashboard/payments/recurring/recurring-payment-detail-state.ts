import type { PaymentRecurringPaymentStatus, PaymentsDashboardWallet } from "@sdp/types";

export function getRecurringPaymentDetailState({
  sourceCustodyWalletId,
  status,
  hasPendingAction,
  savingPayment,
  sourceWallet,
  selectedWallet,
  selectedCustodyWalletId,
}: {
  sourceCustodyWalletId: string | null;
  status: PaymentRecurringPaymentStatus;
  hasPendingAction: boolean;
  savingPayment: boolean;
  sourceWallet: Pick<PaymentsDashboardWallet, "isRuntimeExecutionAllowed"> | undefined;
  selectedWallet: Pick<PaymentsDashboardWallet, "isRuntimeExecutionAllowed"> | undefined;
  selectedCustodyWalletId: string;
}) {
  const sourceWalletUnresolved = sourceCustodyWalletId === null;
  const controlsDisabled = sourceWalletUnresolved || hasPendingAction || savingPayment;
  const signingUnavailable = sourceWallet?.isRuntimeExecutionAllowed !== true;
  // The active editor replaces the on-chain subscription; pending edits only save data.
  const editWalletUnavailable =
    (!!selectedCustodyWalletId && !selectedWallet) ||
    (status === "active" &&
      (signingUnavailable || selectedWallet?.isRuntimeExecutionAllowed !== true));

  return {
    sourceWalletUnresolved,
    isEditable: !sourceWalletUnresolved && (status === "pending_activation" || status === "active"),
    controlsDisabled,
    signingUnavailable,
    editWalletUnavailable,
    saveDisabled: controlsDisabled || editWalletUnavailable,
    signingActionsDisabled: controlsDisabled || signingUnavailable,
    cancelDisabled: controlsDisabled || (status !== "pending_activation" && signingUnavailable),
  };
}
