import type { PaymentTransactionKind } from "@sdp/types";
import type { PaymentTransferDirection } from "./payments.repository";

export const PAYMENT_TRANSACTION_KIND_SQL = `CASE
  WHEN pt.type = 'onramp' THEN 'onramp'
  WHEN pt.type = 'offramp' THEN 'offramp'
  WHEN pt.type = 'transfer_batch' THEN 'batch_pay'
  WHEN pt.type = 'transfer_confidential' THEN 'confidential_pay'
  WHEN EXISTS (SELECT 1 FROM payment_subscription_collection_attempts psca WHERE psca.transfer_id = pt.id) THEN 'recurring_pay'
  WHEN EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.fulfilled_by_transfer_id = pt.id) THEN 'request_deposit'
  WHEN pt.direction = 'inbound' THEN 'deposit'
  ELSE 'pay'
END`;

export function observedTransferKind(direction: PaymentTransferDirection): PaymentTransactionKind {
  return direction === "inbound" ? "deposit" : "pay";
}
