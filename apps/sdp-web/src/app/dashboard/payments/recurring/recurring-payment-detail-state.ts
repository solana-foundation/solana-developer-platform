import type { PaymentRecurringPaymentStatus } from "@sdp/types";

export function getRecurringPaymentDetailState({
  sourceCustodyWalletId,
  status,
  hasPendingAction,
  savingPayment,
}: {
  sourceCustodyWalletId: string | null;
  status: PaymentRecurringPaymentStatus;
  hasPendingAction: boolean;
  savingPayment: boolean;
}) {
  const sourceWalletUnresolved = sourceCustodyWalletId === null;

  return {
    sourceWalletUnresolved,
    isEditable: !sourceWalletUnresolved && (status === "pending_activation" || status === "active"),
    controlsDisabled: sourceWalletUnresolved || hasPendingAction || savingPayment,
  };
}
