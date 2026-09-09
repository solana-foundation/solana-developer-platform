-- Per-side party ownership of a DvP trade (PRO-1893, slice 1).
--
-- A trade row asserts two addresses and a settlement authority, and that is all
-- the program knows. The creator-leg columns (`sdp_side`, `trade_kind`,
-- `sdp_wallet_id`, the three funding columns) described ONE leg and are
-- subsumed by `dvp_leg_funding_claims` (0090), keyed (trade, side) and owned
-- by the funder. "Can SDP act on a side" becomes a lookup: an org holds a side
-- iff it holds an active custody wallet whose `public_key` is that side's
-- `user_x`.
--
-- The two new per-side attribution columns are app-enforced, not SQL-bound:
-- the referenced account is `crypto_wallet` kind, active, in the creator's
-- org/project, address equal to the party — and that address lives in
-- `counterparty_accounts.details` JSONB, so no CHECK can bind it.

-- 1. Per-side counterparty attribution. Nullable until the creator links a
--    side; ON DELETE RESTRICT, like every evidence-bearing FK here, so a
--    named account cannot be deleted out from under a settled trade.
ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS counterparty_account_id_a TEXT NULL
        REFERENCES counterparty_accounts(id) ON DELETE RESTRICT;
ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS counterparty_account_id_b TEXT NULL
        REFERENCES counterparty_accounts(id) ON DELETE RESTRICT;

-- 2. Backfill in-flight creator-leg funding into dvp_leg_funding_claims.
--    0090 already carries the same lock keyed (trade, side), so the column is
--    migrated there rather than dropped in place; ON CONFLICT DO NOTHING keeps
--    a fresher claims row. The COALESCE on expiry_height is deliberate:
--    `expiry_height` is NOT NULL, pre-0084 rows have no recorded expiry, and
--    '0' makes an untracked lock immediately sweepable — safe because the
--    sweep never touches a row with `funding_tx` set. The column-existence
--    guard keeps a re-run a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'dvp_trades' AND column_name = 'sdp_leg_funding_signature'
  ) THEN
    -- A funded leg whose claim the sweep already released carries only the
    -- receipt (signature NULL, funding_tx set) — it must migrate too, or the
    -- receipt dies with the column below. COALESCE folds both shapes.
    INSERT INTO dvp_leg_funding_claims
      (trade_id, side, organization_id, project_id, custody_wallet_id,
       signature, expiry_height, funding_tx)
    SELECT id, sdp_side, organization_id, project_id, sdp_wallet_id,
           COALESCE(sdp_leg_funding_signature, sdp_leg_funding_tx),
           COALESCE(funding_claim_expiry_height, '0'),
           sdp_leg_funding_tx
      FROM dvp_trades
     WHERE (sdp_leg_funding_signature IS NOT NULL OR sdp_leg_funding_tx IS NOT NULL)
       AND sdp_side IS NOT NULL
    ON CONFLICT (trade_id, side) DO NOTHING;
  END IF;
END $$;

-- 3. Drop the cross-column constraints referencing the dying columns FIRST —
--    `dvp_trades_kind_side_check` spans two columns, so it must go early.
ALTER TABLE dvp_trades DROP CONSTRAINT IF EXISTS dvp_trades_trade_kind_check;
ALTER TABLE dvp_trades DROP CONSTRAINT IF EXISTS dvp_trades_kind_side_check;

-- 4. Drop the six columns. Single-column constraints ride along (PostgreSQL
--    drops a CHECK/FK whose only referenced column is dropped).
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_side;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS trade_kind;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_wallet_id;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_leg_funding_signature;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS funding_claim_expiry_height;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_leg_funding_tx;

-- 5. RLS: 0086 (`sdp_tenant_isolation`) and 0089 (`sdp_dvp_party_read`) are
--    already keyed on `user_a`/`user_b`; no dropped column is referenced, so
--    no recreation is needed.
