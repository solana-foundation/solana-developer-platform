import type { PaymentTransferSummary } from "@sdp/types";
import { resolveTransactionCounterpartyReference } from "./transactions/transactions-counterparty";

export function resolveCommandCenterCounterparty(transfer: PaymentTransferSummary): string {
  return (
    transfer.counterpartyDisplayName ?? resolveTransactionCounterpartyReference(transfer) ?? "—"
  );
}
