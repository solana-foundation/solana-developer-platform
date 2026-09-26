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
  trim_scale(r.amount::numeric /
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
  -- The close names the wallet that signed it, which the trade row records
  -- when SDP performed the close (0120). Only a close we cannot name this way —
  -- one observed from the chain, or recorded before that column existed — is
  -- resolved from the recorded authority address below.
  COALESCE(t.close_custody_wallet_id, authority.id),
  CASE side.value WHEN 'a' THEN t.mint_a WHEN 'b' THEN t.mint_b END AS token,
  trim_scale((CASE side.value WHEN 'a' THEN t.escrow_a_peak_amount WHEN 'b' THEN t.escrow_b_peak_amount END)::numeric /
    (10::numeric ^ CASE side.value WHEN 'a' THEN t.decimals_a WHEN 'b' THEN t.decimals_b END))::text AS amount,
  NULL::text AS counterparty_id,
  t.close_signature AS signature,
  t.closed_at AS created_at
FROM dvp_trades t
CROSS JOIN (VALUES ('a'), ('b')) AS side(value)
LEFT JOIN LATERAL (
  -- The fallback for a close the trade row cannot name: the close was signed by
  -- the trade's settlement authority, so that is the custody wallet a close row
  -- names: the recorded authority address, resolved through the wallet that
  -- holds it. Not the side's funding claim — a cross-organization close must
  -- not carry another tenant's wallet id, and a settlement-wallet-scoped read
  -- must find the closes its wallet signed. The address is only a key; the
  -- wallet that holds it is a tenant fact, so the lookup is scoped to the
  -- trade's own organization and project (an organization-level custody config
  -- is the fallback), and a project-scoped match wins over an org-level one.
  -- The same public key can be recorded on more than one custody wallet — a
  -- provisioning race leaves the loser behind, and a rotated mapping does not
  -- migrate older trades — so the wallet the trade's own project maps as its
  -- settlement wallet (0079) wins first. That mapping is the record the close
  -- flow itself resolves and requires to match the trade's authority before
  -- signing, so within a project it cannot name a wallet that never signed;
  -- the scan only breaks the tie, and stays the fallback for a mapping that
  -- has since rotated to a different key — for which the recorded wallet
  -- (0120), when there is one, has already answered.
  SELECT w.id
    FROM custody_wallets w
    JOIN custody_configs cfg ON cfg.id = w.custody_config_id
    LEFT JOIN dvp_settlement_wallets sw
      ON sw.project_id = t.project_id AND sw.organization_id = t.organization_id
   WHERE w.public_key = t.settlement_authority
     AND cfg.organization_id = t.organization_id
     AND (cfg.project_id = t.project_id OR cfg.project_id IS NULL)
   ORDER BY (w.id = sw.custody_wallet_id) DESC NULLS LAST,
            (cfg.project_id = t.project_id) DESC NULLS LAST
   LIMIT 1
) authority ON TRUE
WHERE t.close_signature IS NOT NULL`,
} as const satisfies UnifiedTransactionSource;
