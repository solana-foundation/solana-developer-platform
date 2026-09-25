import type { UnifiedTransactionSource } from "./types";

export const dvpUnifiedTransactionSource = {
  sql: () => `SELECT
  t.id || ':fund:' || c.side AS id,
  t.id AS module_id,
  'fund' AS kind,
  t.status AS module_status,
  c.organization_id,
  c.project_id,
  c.custody_wallet_id,
  CASE c.side WHEN 'a' THEN t.mint_a WHEN 'b' THEN t.mint_b END AS token,
  trim_scale((CASE c.side WHEN 'a' THEN t.escrow_a_peak_amount WHEN 'b' THEN t.escrow_b_peak_amount END)::numeric /
    (10::numeric ^ CASE c.side WHEN 'a' THEN t.decimals_a WHEN 'b' THEN t.decimals_b END))::text AS amount,
  NULL::text AS counterparty_id,
  c.signature,
  c.created_at
FROM dvp_leg_funding_claims c
JOIN dvp_trades t ON t.id = c.trade_id
UNION ALL
SELECT
  t.id || ':close:' || side.value AS id,
  t.id AS module_id,
  'close' AS kind,
  t.status AS module_status,
  t.organization_id,
  t.project_id,
  c.custody_wallet_id,
  CASE side.value WHEN 'a' THEN t.mint_a WHEN 'b' THEN t.mint_b END AS token,
  -- The close's own escrow delta as the reconciler read it off the chain, not
  -- the escrow's historical peak: a leg that peaked, was reclaimed and was
  -- re-funded before closing would otherwise report the peak. A close the
  -- ledger has not matched yet reads as unknown (NULL) rather than a guess.
  trim_scale(close_transfer.amount::numeric /
    (10::numeric ^ CASE side.value WHEN 'a' THEN t.decimals_a WHEN 'b' THEN t.decimals_b END))::text AS amount,
  NULL::text AS counterparty_id,
  t.close_signature AS signature,
  t.closed_at AS created_at
FROM dvp_trades t
CROSS JOIN (VALUES ('a'), ('b')) AS side(value)
LEFT JOIN dvp_leg_funding_claims c ON c.trade_id = t.id AND c.side = side.value
LEFT JOIN dvp_leg_transfers close_transfer
  ON close_transfer.trade_id = t.id
 AND close_transfer.side = side.value
 AND close_transfer.signature = t.close_signature
WHERE t.close_signature IS NOT NULL`,
} as const satisfies UnifiedTransactionSource;
