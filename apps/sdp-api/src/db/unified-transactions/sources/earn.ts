import type { UnifiedTransactionSource } from "./types";

/**
 * Earn movements in the unified ledger.
 *
 * A vault withdrawal is recorded in SHARES (`denomination` is the share mint,
 * `amount_requested` / `amount_settled` the share quantity); the customer's
 * payout in the deposit token is observed at settlement into
 * `token_amount_settled` (0103). Once that payout is known the ledger reports
 * it, in the position's deposit-token mint, so a finalized withdrawal reads
 * the way the customer experienced it. Until then (in flight, or a payout the
 * settlement could not observe) the row keeps the share quantity and share
 * mint, so amount and token always describe the same unit. Deposits are
 * valued only after receipt observation for Kamino; legacy projections are
 * hidden until repair establishes the actual debit.
 */
export const earnUnifiedTransactionSource = {
  sql: (helpers) => `SELECT
  em.id,
  em.id AS module_id,
  CASE em.direction WHEN 'deposit' THEN 'deposit' WHEN 'withdrawal' THEN 'withdraw' END AS kind,
  em.status AS module_status,
  em.organization_id,
  em.project_id,
  em.custody_wallet_id,
  CASE
    WHEN em.denomination = 'usd' THEN em.payout_token
    WHEN em.token_amount_settled IS NOT NULL AND ep.token_mint IS NOT NULL THEN ep.token_mint
    ELSE em.denomination
  END AS token,
  CASE
    WHEN em.provider = 'kamino' AND em.execution_model = 'vault_direct'
      AND em.direction = 'deposit' AND em.status = 'finalized'
      AND em.deposit_receipt_observed_at IS NULL THEN NULL::text
    WHEN em.status IN (${helpers.moduleStatusesOf("succeeded").join(", ")})
      THEN COALESCE(em.token_amount_settled, em.amount_settled)
    ELSE em.amount_requested
  END AS amount,
  NULL::text AS counterparty_id,
  em.signature,
  em.created_at
FROM earn_movements em
LEFT JOIN earn_positions ep ON ep.id = em.position_id`,
} as const satisfies UnifiedTransactionSource;
