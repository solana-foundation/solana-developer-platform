import type { PaymentTransferSummary } from "@sdp/types";
import { shortenAddress } from "../payments-overview.utils";

type TransactionCounterpartyFields = Pick<
  PaymentTransferSummary,
  "counterpartyDisplayName" | "counterpartyId" | "type" | "direction" | "source" | "destination"
>;

export interface TransactionCounterpartyPresentation {
  displayName?: string;
  primary: string;
  reference?: string;
  secondary?: string;
}

export function resolveTransactionCounterpartyReference(
  transfer: TransactionCounterpartyFields
): string | undefined {
  const counterpartyId = transfer.counterpartyId?.trim() || undefined;
  if (counterpartyId) return counterpartyId;

  const source = transfer.source?.trim() || undefined;
  const destination = transfer.destination?.trim() || undefined;
  if (transfer.direction === "inbound") return source ?? destination;
  if (transfer.direction === "outbound") return destination ?? source;
  if (transfer.type === "onramp") return source ?? destination;
  if (transfer.type === "offramp") return destination ?? source;
  return destination ?? source;
}

export function getTransactionCounterpartyPresentation(
  transfer: TransactionCounterpartyFields
): TransactionCounterpartyPresentation {
  const displayName = transfer.counterpartyDisplayName?.trim() || undefined;
  const reference = resolveTransactionCounterpartyReference(transfer);

  return {
    ...(displayName ? { displayName } : {}),
    primary: displayName ?? (reference ? shortenAddress(reference) : "—"),
    ...(reference ? { reference } : {}),
    ...(displayName && reference ? { secondary: shortenAddress(reference) } : {}),
  };
}

export function retainTransactionCounterpartyDisplayName(
  detail: PaymentTransferSummary,
  summary: TransactionCounterpartyFields
): PaymentTransferSummary {
  const displayName =
    detail.counterpartyDisplayName?.trim() || summary.counterpartyDisplayName?.trim() || undefined;

  return displayName ? { ...detail, counterpartyDisplayName: displayName } : detail;
}
