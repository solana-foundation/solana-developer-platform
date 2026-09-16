import { PAYMENT_TRANSACTION_KIND_SQL } from "../../repositories/payments.kind";
import type { UnifiedTransactionSource } from "./types";

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
  pt.signature,
  pt.created_at
FROM payment_transfers pt`,
} as const satisfies UnifiedTransactionSource;
