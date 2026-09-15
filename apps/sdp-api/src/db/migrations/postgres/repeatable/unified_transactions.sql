DROP VIEW IF EXISTS unified_transactions;
CREATE VIEW unified_transactions WITH (security_invoker = true) AS
SELECT
  unified.id,
  unified.module_id,
  unified.kind,
  unified.module_status,
  unified.organization_id,
  unified.project_id,
  unified.custody_wallet_id,
  cw.label AS custody_wallet_label,
  unified.token,
  unified.amount,
  unified.counterparty_id,
  unified.signature,
  unified.created_at,
  unified.module,
  unified.status
FROM (
SELECT
  id,
  module_id,
  kind,
  module_status,
  organization_id,
  project_id,
  custody_wallet_id,
  token,
  amount,
  counterparty_id,
  signature,
  created_at,
  'payments' AS module,
  CASE module_status
    WHEN 'pending' THEN 'pending'
    WHEN 'processing' THEN 'pending'
    WHEN 'awaiting_payment' THEN 'pending'
    WHEN 'settling' THEN 'pending'
    WHEN 'confirmed' THEN 'succeeded'
    WHEN 'finalized' THEN 'succeeded'
    WHEN 'completed' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
    WHEN 'canceled' THEN 'canceled'
    WHEN 'expired' THEN 'canceled'
  END AS status
FROM (
SELECT
  pt.id,
  pt.id AS module_id,
  CASE
  WHEN pt.type = 'onramp' THEN 'onramp'
  WHEN pt.type = 'offramp' THEN 'offramp'
  WHEN pt.type = 'transfer_batch' THEN 'batch_pay'
  WHEN pt.type = 'transfer_confidential' THEN 'confidential_pay'
  WHEN EXISTS (SELECT 1 FROM payment_subscription_collection_attempts psca WHERE psca.transfer_id = pt.id) THEN 'recurring_pay'
  WHEN EXISTS (SELECT 1 FROM payment_requests pr WHERE pr.fulfilled_by_transfer_id = pt.id) THEN 'request_deposit'
  WHEN pt.direction = 'inbound' THEN 'deposit'
  ELSE 'pay'
END AS kind,
  pt.status AS module_status,
  pt.organization_id,
  pt.project_id,
  pt.custody_wallet_id,
  pt.token,
  pt.amount,
  pt.counterparty_id,
  pt.signature,
  pt.created_at
FROM payment_transfers pt
) payments
UNION ALL
SELECT
  id,
  module_id,
  kind,
  module_status,
  organization_id,
  project_id,
  custody_wallet_id,
  token,
  amount,
  counterparty_id,
  signature,
  created_at,
  'earn' AS module,
  CASE module_status
    WHEN 'requested' THEN 'pending'
    WHEN 'processing' THEN 'pending'
    WHEN 'pending_approval' THEN 'pending'
    WHEN 'submitted' THEN 'pending'
    WHEN 'confirmed' THEN 'succeeded'
    WHEN 'finalized' THEN 'succeeded'
    WHEN 'completed' THEN 'succeeded'
    WHEN 'partially_completed' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
    WHEN 'cancelled' THEN 'canceled'
  END AS status
FROM (
SELECT
  em.id,
  em.id AS module_id,
  CASE em.direction WHEN 'deposit' THEN 'deposit' WHEN 'withdrawal' THEN 'withdraw' END AS kind,
  em.status AS module_status,
  em.organization_id,
  em.project_id,
  em.custody_wallet_id,
  CASE WHEN em.denomination = 'usd' THEN em.payout_token ELSE em.denomination END AS token,
  CASE WHEN em.status IN ('completed', 'partially_completed', 'confirmed', 'finalized') THEN em.amount_settled ELSE em.amount_requested END AS amount,
  NULL::text AS counterparty_id,
  em.signature,
  em.created_at
FROM earn_movements em
) earn
UNION ALL
SELECT
  id,
  module_id,
  kind,
  module_status,
  organization_id,
  project_id,
  custody_wallet_id,
  token,
  amount,
  counterparty_id,
  signature,
  created_at,
  'dvp' AS module,
  CASE module_status
    WHEN 'creating' THEN 'pending'
    WHEN 'created' THEN 'pending'
    WHEN 'partially_funded' THEN 'pending'
    WHEN 'funded' THEN 'pending'
    WHEN 'closed_unknown' THEN 'pending'
    WHEN 'settled' THEN 'succeeded'
    WHEN 'create_failed' THEN 'failed'
    WHEN 'cancelled' THEN 'canceled'
    WHEN 'rejected' THEN 'canceled'
    WHEN 'expired' THEN 'canceled'
  END AS status
FROM (
SELECT
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
  trim_scale((CASE side.value WHEN 'a' THEN t.escrow_a_peak_amount WHEN 'b' THEN t.escrow_b_peak_amount END)::numeric /
    (10::numeric ^ CASE side.value WHEN 'a' THEN t.decimals_a WHEN 'b' THEN t.decimals_b END))::text AS amount,
  NULL::text AS counterparty_id,
  t.close_signature AS signature,
  t.closed_at AS created_at
FROM dvp_trades t
CROSS JOIN (VALUES ('a'), ('b')) AS side(value)
LEFT JOIN dvp_leg_funding_claims c ON c.trade_id = t.id AND c.side = side.value
WHERE t.close_signature IS NOT NULL
) dvp
UNION ALL
SELECT
  id,
  module_id,
  kind,
  module_status,
  organization_id,
  project_id,
  custody_wallet_id,
  token,
  amount,
  counterparty_id,
  signature,
  created_at,
  'private_channels' AS module,
  CASE module_status
    WHEN 'pending' THEN 'pending'
    WHEN 'submitted' THEN 'pending'
    WHEN 'confirmed' THEN 'succeeded'
    WHEN 'settled' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
  END AS status
FROM (
SELECT id, id AS module_id, 'transfer' AS kind, status AS module_status, organization_id, project_id, NULL::text AS custody_wallet_id, mint AS token, amount, NULL::text AS counterparty_id, signature, created_at FROM private_channel_transfers
UNION ALL
SELECT id, id AS module_id, 'deposit' AS kind, status AS module_status, organization_id, project_id, NULL::text AS custody_wallet_id, mint AS token, amount, NULL::text AS counterparty_id, signature, created_at FROM private_channel_deposits
UNION ALL
SELECT id, id AS module_id, 'withdraw' AS kind, status AS module_status, organization_id, project_id, NULL::text AS custody_wallet_id, mint AS token, amount, NULL::text AS counterparty_id, signature, created_at FROM private_channel_withdrawals
) private_channels
UNION ALL
SELECT
  id,
  module_id,
  kind,
  module_status,
  organization_id,
  project_id,
  custody_wallet_id,
  token,
  amount,
  counterparty_id,
  signature,
  created_at,
  'issuance' AS module,
  CASE module_status
    WHEN 'pending' THEN 'pending'
    WHEN 'processing' THEN 'pending'
    WHEN 'confirmed' THEN 'succeeded'
    WHEN 'finalized' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
  END AS status
FROM (
SELECT
  it.id,
  it.id AS module_id,
  it.type AS kind,
  it.status AS module_status,
  it.organization_id,
  tok.project_id,
  it.custody_wallet_id,
  tok.mint_address AS token,
  NULL::text AS amount,
  NULL::text AS counterparty_id,
  it.signature,
  it.created_at
FROM issuance_transactions it
JOIN issued_tokens tok ON tok.id = it.token_id
) issuance
UNION ALL
SELECT
  id,
  module_id,
  kind,
  module_status,
  organization_id,
  project_id,
  custody_wallet_id,
  token,
  amount,
  counterparty_id,
  signature,
  created_at,
  'rings' AS module,
  CASE module_status
    WHEN 'draft' THEN 'pending'
    WHEN 'preparing' THEN 'pending'
    WHEN 'approval_required' THEN 'pending'
    WHEN 'proving' THEN 'pending'
    WHEN 'ready_to_sign' THEN 'pending'
    WHEN 'submitted' THEN 'pending'
    WHEN 'indexing' THEN 'pending'
    WHEN 'completed' THEN 'succeeded'
    WHEN 'failed' THEN 'failed'
    WHEN 'voided' THEN 'canceled'
  END AS status
FROM (
SELECT
  o.id,
  o.id AS module_id,
  o.op_type AS kind,
  o.state AS module_status,
  o.organization_id,
  o.project_id,
  wallet.custody_wallet_id,
  o.asset_mint AS token,
  trim_scale(o.amount_raw::numeric / (10::numeric ^ al.decimals))::text AS amount,
  NULL::text AS counterparty_id,
  o.outer_tx_signature AS signature,
  o.created_at
FROM helius_rings_operations o
JOIN helius_rings_wallets wallet ON wallet.id = o.wallet_id AND wallet.organization_id = o.organization_id AND wallet.project_id = o.project_id
LEFT JOIN helius_rings_asset_allowlist al ON al.mint = o.asset_mint
) rings
) unified
LEFT JOIN custody_wallets cw ON cw.id = unified.custody_wallet_id;
