import { PAYMENT_TRANSACTION_KIND_SQL } from "../../repositories/payments.kind";
import type { UnifiedTransactionSource } from "./types";

/**
 * Payment transfers in the unified ledger. The counterparty is the address on
 * the far side of the transfer from the SDP wallet: the sender of an inbound
 * transfer, otherwise the destination — the same rule the dashboard's wallet
 * Activity tab applies to `PaymentTransferSummary`.
 */
export const paymentsUnifiedTransactionSource = {
  sql: () => `SELECT
  pt.id,
  pt.id AS module_id,
  ${PAYMENT_TRANSACTION_KIND_SQL} AS kind,
  pt.status AS module_status,
  pt.organization_id,
  pt.project_id,
  pt.custody_wallet_id,
  pt.token,
  pt.amount,
  pt.counterparty_id,
  CASE WHEN pt.direction = 'inbound' THEN pt.source_address ELSE pt.destination_address END AS counterparty_address,
  pt.signature,
  pt.created_at
FROM payment_transfers pt`,
} as const satisfies UnifiedTransactionSource;
