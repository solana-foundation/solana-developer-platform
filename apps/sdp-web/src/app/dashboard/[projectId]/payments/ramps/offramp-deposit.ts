"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import { toast } from "sonner";
import type { CreateTransferInput, Translate } from "../payments-workspace.data";

/** Present the result of funding one existing off-ramp transfer. */
export async function submitOfframpDeposit(
  submission: CreateTransferInput & { transferId: string },
  send: (input: CreateTransferInput) => Promise<PaymentTransferSummary>,
  t: Translate
): Promise<void> {
  const toastId = toast.loading(t("DashboardPayments.ramps.submittingOnchainTransfer"), {
    position: "bottom-right",
  });

  try {
    const transfer = await send(submission);
    if (transfer.id !== submission.transferId) {
      throw new Error(t("DashboardPayments.ramps.transferFailed"));
    }
    toast.success(t("DashboardPayments.ramps.transferSubmitted"), {
      id: toastId,
      description: transfer.signature
        ? t("DashboardPayments.ramps.transactionSentSuccessfully")
        : t("DashboardPayments.ramps.transferStatus", { status: transfer.status }),
      position: "bottom-right",
    });
  } catch (error) {
    toast.error(t("DashboardPayments.ramps.transferFailed"), {
      id: toastId,
      description:
        error instanceof Error ? error.message : t("DashboardPayments.ramps.transferFailed"),
      position: "bottom-right",
    });
  }
}
