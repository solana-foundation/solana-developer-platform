"use client";

import { toast } from "sonner";
import type {
  CreateTransferInput,
  CreateTransferOutcome,
  Translate,
} from "../payments-workspace.data";

/** Present the result of funding one existing off-ramp transfer. */
export async function submitOfframpDeposit(
  submission: CreateTransferInput & { transferId: string },
  send: (input: CreateTransferInput) => Promise<CreateTransferOutcome>,
  t: Translate
): Promise<void> {
  const toastId = toast.loading(t("DashboardPayments.ramps.submittingOnchainTransfer"), {
    position: "bottom-right",
  });

  try {
    const outcome = await send(submission);
    if (outcome.kind === "approval_pending") {
      toast.info(t("DashboardPayments.onchainSend.approvalPendingTitle"), {
        id: toastId,
        description: t("DashboardPayments.onchainSend.approvalPendingDescription"),
        position: "bottom-right",
      });
      return;
    }
    const transfer = outcome.transfer;
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
