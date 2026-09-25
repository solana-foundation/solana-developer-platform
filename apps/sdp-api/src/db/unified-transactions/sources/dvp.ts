import type { UnifiedTransactionSource } from "./types";

export const dvpUnifiedTransactionSource = {
  sql: () => `SELECT
  t.id || ':fund:' || r.side || ':' || r.signature AS id,
  t.id AS module_id,
  'fund' AS kind,
  t.status AS module_status,
  r.organization_id,
  r.project_id,
  r.custody_wallet_id,
  CASE r.side WHEN 'a' THEN t.mint_a WHEN 'b' THEN t.mint_b END AS token,
  trim_scale((CASE r.side WHEN 'a' THEN t.escrow_a_peak_amount WHEN 'b' THEN t.escrow_b_peak_amount END)::numeric /
    (10::numeric ^ CASE r.side WHEN 'a' THEN t.decimals_a WHEN 'b' THEN t.decimals_b END))::text AS amount,
  NULL::text AS counterparty_id,
  r.signature,
  r.created_at
FROM dvp_leg_funding_receipts r
JOIN dvp_trades t ON t.id = r.trade_id
UNION ALL
SELECT
  t.id || ':close:' || side.value AS id,
  t.id AS module_id,
  'close' AS kind,
  t.status AS module_status,
  t.organization_id,
  t.project_id,
  authority.id,
  CASE side.value WHEN 'a' THEN t.mint_a WHEN 'b' THEN t.mint_b END AS token,
  trim_scale((CASE side.value WHEN 'a' THEN t.escrow_a_peak_amount WHEN 'b' THEN t.escrow_b_peak_amount END)::numeric /
    (10::numeric ^ CASE side.value WHEN 'a' THEN t.decimals_a WHEN 'b' THEN t.decimals_b END))::text AS amount,
  NULL::text AS counterparty_id,
  t.close_signature AS signature,
  t.closed_at AS created_at
FROM dvp_trades t
CROSS JOIN (VALUES ('a'), ('b')) AS side(value)
LEFT JOIN LATERAL (
  -- The close was signed by the trade's settlement authority, so that is the
  -- custody wallet a close row names: the recorded authority address, resolved
  -- through the wallet that holds it. Not the side's funding claim — a
  -- cross-organization close must not carry another tenant's wallet id, and a
  -- settlement-wallet-scoped read must find the closes its wallet signed.
  SELECT w.id
    FROM custody_wallets w
   WHERE w.public_key = t.settlement_authority
   LIMIT 1
) authority ON TRUE
WHERE t.close_signature IS NOT NULL`,
} as const satisfies UnifiedTransactionSource;
