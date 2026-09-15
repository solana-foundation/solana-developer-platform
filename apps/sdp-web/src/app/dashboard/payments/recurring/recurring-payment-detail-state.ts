import {
  isEditableRecurringPaymentStatus,
  type PaymentRecurringPaymentStatus,
  type PaymentsDashboardWallet,
} from "@sdp/types";

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
  // Unavailable covers both "not allowed" and "not known"; only the former is a
  // signing restriction the reader can act on.
  const signingUnavailable = sourceWallet?.isRuntimeExecutionAllowed !== true;
  const signingDisabled = sourceWallet !== undefined && !sourceWallet.isRuntimeExecutionAllowed;
  // The active editor replaces the on-chain subscription; pending edits only save data.
  const editWalletUnavailable =
    (!!selectedCustodyWalletId && !selectedWallet) ||
    (status === "active" &&
      (signingUnavailable || selectedWallet?.isRuntimeExecutionAllowed !== true));

  return {
    sourceWalletUnresolved,
    // Editing an active payment replaces its on-chain subscription, which needs
    // the current wallet's signature; a pending edit only saves data.
    isEditable:
      !sourceWalletUnresolved &&
      isEditableRecurringPaymentStatus(status) &&
      (status !== "active" || !signingUnavailable),
    controlsDisabled,
    signingUnavailable,
    signingDisabled,
    editWalletUnavailable,
    saveDisabled: controlsDisabled || editWalletUnavailable,
    signingActionsDisabled: controlsDisabled || signingUnavailable,
    cancelDisabled: controlsDisabled || (status !== "pending_activation" && signingUnavailable),
  };
}
