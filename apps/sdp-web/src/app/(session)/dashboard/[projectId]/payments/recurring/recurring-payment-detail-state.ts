import {
  isEditableRecurringPaymentStatus,
  type PaymentRecurringPaymentStatus,
  type PaymentsDashboardWallet,
} from "@sdp/types/payments";
import { IdempotencyOutcomeUnknownError } from "@/lib/idempotency";
import { RecurringPaymentChangedError } from "./recurring-payments.data";

/**
 * What the detail page shows when its schedule can't be read. A 404 says there is no such
 * schedule. Anything else (a 5xx, a network failure, a body that doesn't parse) is a failure
 * to find out, not an absence.
 */
export function recurringPaymentReadFailureOutcome(status: number | null): "not_found" | "failed" {
  return status === 404 ? "not_found" : "failed";
}

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

/**
 * After a failed recurring action: an unknown outcome or a reused key (the
 * action may have run) refreshes the page, so its status and controls show
 * what happened, and so does a refusal of a version the page no longer shows,
 * so the next try acts on the current one.
 */
export function refreshIfOutcomeUnknown(cause: unknown, refresh: () => void): void {
  if (
    cause instanceof IdempotencyOutcomeUnknownError ||
    cause instanceof RecurringPaymentChangedError
  ) {
    refresh();
  }
}
