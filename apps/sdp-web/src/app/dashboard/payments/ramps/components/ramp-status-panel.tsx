"use client";

import type { PaymentTransferSummary } from "@sdp/types";
import type { RampDirection } from "@sdp/types/ramp-requirements";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";

interface TransferStatusCopy {
  title: string;
  description: string;
  state: "loading" | "success" | "error";
}

function transferStatusCopy(direction: RampDirection, status: string): TransferStatusCopy {
  const onramp = direction === "onramp";
  switch (status) {
    case "pending":
    case "awaiting_payment":
      return {
        title: onramp ? "Waiting for funding" : "Waiting to send",
        description: onramp
          ? "Send the funds using the instructions above. We will update this deposit automatically once the provider receives payment."
          : "Complete the payout using the instructions above. We will update this outgoing transfer automatically once the provider receives your crypto.",
        state: "loading",
      };
    case "processing":
    case "settling":
      return {
        title: onramp ? "Deposit received" : "Sending payout",
        description: onramp
          ? "The provider has received funds and is settling the deposit to the destination wallet."
          : "The provider received your crypto and is settling the outgoing payout to the recipient.",
        state: "loading",
      };
    case "completed":
      return {
        title: onramp ? "Transfer complete" : "Payout sent",
        description: onramp
          ? "The deposit is complete. You can review the transfer from the counterparty record."
          : "The outgoing payout has settled. You can review this transfer from the counterparty record.",
        state: "success",
      };
    case "failed":
      return {
        title: onramp ? "Transfer failed" : "Payout failed",
        description: onramp
          ? "The provider reported that this deposit failed. Review the counterparty record for the latest transfer status."
          : "The provider reported that this outgoing payout failed. Review the counterparty record for the latest transfer status.",
        state: "error",
      };
    case "expired":
      return {
        title: "Quote expired",
        description: onramp
          ? "This quote expired before the transfer completed. Create a new quote to continue funding."
          : "This quote expired before the payout completed. Create a new quote to continue the withdrawal.",
        state: "error",
      };
    default:
      return {
        title: "Transfer status updated",
        description: `Current provider status: ${status}.`,
        state: "loading",
      };
  }
}

function statusIcon(state: TransferStatusCopy["state"]) {
  switch (state) {
    case "success":
      return <CheckCircle2Icon className="size-5 text-status-success-text" />;
    case "error":
      return <XCircleIcon className="size-5 text-status-error-text" />;
    case "loading":
      return <Loader2Icon className="size-5 animate-spin text-text-medium" />;
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled transfer status state: ${exhaustive}`);
    }
  }
}

export function RampStatusPanel({
  direction,
  transfer,
}: {
  direction: RampDirection;
  transfer: PaymentTransferSummary | null | undefined;
}) {
  const copy: TransferStatusCopy = transfer
    ? transferStatusCopy(direction, transfer.status)
    : {
        title: "Preparing transfer status",
        description: "We are waiting for the transfer record tied to this quote.",
        state: "loading",
      };
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 shrink-0">{statusIcon(copy.state)}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-extra-high">{copy.title}</p>
        <p className="mt-1 text-sm leading-relaxed text-text-low">{copy.description}</p>
      </div>
    </div>
  );
}
