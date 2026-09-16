import type { PaymentTransferSummary } from "@sdp/types";
import { resolveTransactionCounterpartyReference } from "./payments-overview.utils";

export function resolveCommandCenterCounterparty(transfer: PaymentTransferSummary): string {
  if (transfer.counterpartyDisplayName !== undefined) return transfer.counterpartyDisplayName;
  const reference = resolveTransactionCounterpartyReference(transfer);
  return reference === undefined ? "—" : reference;
}
