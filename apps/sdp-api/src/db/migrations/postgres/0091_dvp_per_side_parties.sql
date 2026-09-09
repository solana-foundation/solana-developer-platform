-- Per-side party ownership of a DvP trade (PRO-1893, slice 1).
--
-- A trade row asserts two addresses and a settlement authority, and that is all
-- the program knows — so it is all the row should assert. `sdp_side`,
-- `trade_kind`, `sdp_wallet_id`, and the three trade-level funding columns all
-- described ONE leg (the creating organization's) and are subsumed by
-- `dvp_leg_funding_claims` (0090), which is keyed `(trade_id, side)` and owned
-- by the funder rather than the trade's author.
--
-- "Can SDP act on a side" stops being a stored column and becomes a lookup: an
-- org holds the operational surface on a side iff it holds an active custody
-- wallet whose `public_key` is that side's `user_x`. Nothing replaces the
-- dropped columns structurally — column position and the custody lookup carry
-- the meaning.
--
-- Two nullable per-side attribution columns arrive: `counterparty_account_id_a`
-- and `counterparty_account_id_b`. Each names which registered counterparty
-- this party is (org-scoped fact, invisible to other tenants); NULL means an
-- external address. They are app-enforced, not SQL-bound: the referenced
-- account is `crypto_wallet` kind, active, belongs to the creator's
-- org/project, and its address equals `user_a`/`user_b`. That address lives in
-- `counterparty_accounts.details` JSONB, so no CHECK can bind it.

-- 1. Per-side counterparty attribution. Nullable: a side is an external
--    address until the creator links it. ON DELETE RESTRICT matches every
--    other evidence-bearing FK in this schema (0090's claims, 0085's receipt):
--    deleting a counterparty account that a trade names would erase an
--    attribution a settled trade may depend on, so it must fail.
ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS counterparty_account_id_a TEXT NULL
        REFERENCES counterparty_accounts(id) ON DELETE RESTRICT;
ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS counterparty_account_id_b TEXT NULL
        REFERENCES counterparty_accounts(id) ON DELETE RESTRICT;

-- 2. Backfill in-flight creator-leg funding into dvp_leg_funding_claims.
--
-- A principal trade's live `sdp_leg_funding_signature` is a lock on the
-- creator's leg (`sdp_side`). 0090 already carries the same lock keyed by
-- (trade, side) and owned by the funder, so the column is migrated there
-- rather than dropped in place. `ON CONFLICT DO NOTHING` keeps a fresher
-- claims-table row for the same (trade, side) — one may exist if 0090's
-- insert was run against a trade that already had a live claim column.
--
-- The COALESCE on expiry_height is a deliberate migration decision, not a
-- code fallback. `expiry_height` is NOT NULL on the claims table. Pre-0084
-- rows can hold a lock with no recorded expiry (the column was added in 0084),
-- and '0' makes such an untracked lock immediately sweepable. That is safe
-- because the sweep in dvp_leg_funding_claim.repository.postgres never
-- touches a row with `funding_tx` set — so a funded leg's receipt survives
-- even if its expiry was synthesised.
--
-- Guarded by a column-existence check so a re-run after the columns are gone
-- is a no-op rather than an error — the backfill must not fire twice, and
-- the `IF EXISTS` checks below are how every other data-migration in this
-- directory stays idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'dvp_trades' AND column_name = 'sdp_leg_funding_signature'
  ) THEN
    INSERT INTO dvp_leg_funding_claims
      (trade_id, side, organization_id, project_id, custody_wallet_id,
       signature, expiry_height, funding_tx)
    SELECT id, sdp_side, organization_id, project_id, sdp_wallet_id,
           sdp_leg_funding_signature, COALESCE(funding_claim_expiry_height, '0'),
           sdp_leg_funding_tx
      FROM dvp_trades
     WHERE sdp_leg_funding_signature IS NOT NULL AND sdp_side IS NOT NULL
    ON CONFLICT (trade_id, side) DO NOTHING;
  END IF;
END $$;

-- 3. Drop the cross-column constraints that reference the dying columns FIRST.
--
-- 0088 added two named constraints on `trade_kind` / `sdp_side`:
-- `dvp_trades_trade_kind_check` and `dvp_trades_kind_side_check`. The
-- kind/side check spans two columns, so it must go before either column can.
ALTER TABLE dvp_trades DROP CONSTRAINT IF EXISTS dvp_trades_trade_kind_check;
ALTER TABLE dvp_trades DROP CONSTRAINT IF EXISTS dvp_trades_kind_side_check;

-- 4. Drop the six columns. Single-column constraints ride along: PostgreSQL
--    drops a CHECK or FK whose only referenced column is dropped, which takes
--    `dvp_trades_sdp_side_check` and the `sdp_wallet_id` FK (both 0077).
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_side;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS trade_kind;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_wallet_id;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_leg_funding_signature;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS funding_claim_expiry_height;
ALTER TABLE dvp_trades DROP COLUMN IF EXISTS sdp_leg_funding_tx;

-- 5. RLS: 0086 (`sdp_tenant_isolation`) and 0089 (`sdp_dvp_party_read`) are
--    already expressed in terms of `user_a` / `user_b` and survive unchanged.
--    0089's `sdp_dvp_caller_is_party` matches custody wallets on `public_key`
--    against `user_a`/`user_b` — exactly the new model's rule. No dropped
--    column is referenced by either policy, so no recreation is needed.
