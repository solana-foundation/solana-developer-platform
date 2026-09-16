import type { UnifiedTransactionSource } from "./types";

export const earnUnifiedTransactionSource = {
  sql: (helpers) => `SELECT
  em.id,
  em.id AS module_id,
  CASE em.direction WHEN 'deposit' THEN 'deposit' WHEN 'withdrawal' THEN 'withdraw' END AS kind,
  em.status AS module_status,
  em.organization_id,
  em.project_id,
  em.custody_wallet_id,
  CASE WHEN em.denomination = 'usd' THEN em.payout_token ELSE em.denomination END AS token,
  CASE WHEN em.status IN (${helpers.moduleStatusesOf("succeeded").join(", ")}) THEN em.amount_settled ELSE em.amount_requested END AS amount,
  NULL::text AS counterparty_id,
  em.signature,
  em.created_at
FROM earn_movements em`,
} as const satisfies UnifiedTransactionSource;
