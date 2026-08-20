-- Solana Earn: project existing holdings and movement history into the unified
-- ledger (PRO-1705).
--
-- Every statement here applies one of 0063's projection views in bulk. The
-- mapping itself lives THERE, shared with the application's dual-write, so this
-- file only decides WHICH rows to project and how to avoid duplicating them.
--
-- ── Idempotent by construction — and precisely what that does NOT cover ────
-- Everything is `INSERT ... SELECT ... ON CONFLICT DO NOTHING` keyed on the
-- LEGACY row's own id, so re-running this can never duplicate a movement.
--
-- `DO NOTHING` converges INSERTS, not ADVANCES, and the difference is
-- load bearing. Migrations apply BEFORE the new revision serves traffic, so
-- there is a window in which the OUTGOING revision still writes the legacy
-- tables alone; the same window reopens for a rollback that briefly restores a
-- legacy-only writer. Two different things happen in it:
--
--   * a row INSERTED in the window is missing here entirely, and a later pass
--     of this projection inserts it — `DO NOTHING` is enough; and
--   * a row ADVANCED in the window (mirrored at `requested`, then moved to
--     `completed` or `confirmed` by the legacy-only writer) already exists under
--     its own id, so `DO NOTHING` leaves the STALE projection in place. The
--     runtime mirror does not rescue it either: the custodial appliers early
--     return on a terminal status, and the vault reconciliation queue selects
--     only ('pending', 'submitted'), so nothing ever touches that row again.
--
-- Closing the second case needs an UPSERT, not this statement, and the release
-- that switches reads ships exactly that — the same projection with
-- `ON CONFLICT ... DO UPDATE`, guarded so a unified-only `finalized` row is
-- never regressed by a legacy row that cannot express it. That pass is where
-- the convergence guarantee lives; this one establishes the history.
--
-- This file is NOT edited to become that pass: the runner ledgers a migration
-- by filename, so editing an applied migration to run again would rewrite
-- applied history. It re-states the projection under a new number instead.
--
-- ── Ids are preserved, never regenerated ──────────────────────────────────
-- A projected movement keeps the legacy row's id, and a projected vault holding
-- keeps `earn_vault_positions.id`. Three things follow, all load bearing:
-- `ON CONFLICT (id)` dedupes against rows the application already mirrored,
-- every GET-by-id and stored reference keeps working when reads switch, and
-- `earn_vault_movements.position_id` needs no translation.
--
-- Timestamps are copied, never re-stamped: `created_at` is when the money moved,
-- and a backfill must not claim the movement happened today.
--
-- ── If this migration fails ───────────────────────────────────────────────
-- 0062's amount format check is the only plausible failure, and it means a
-- legacy row holds an `amount_requested_usd` the app-layer schema should have
-- made impossible (non-decimal, or zero). That is a real data finding, not a
-- migration bug: inspect the row rather than loosening the constraint.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Holdings first — both movement projections join a position.
--
-- The custodial mint is the one projection that generates an id rather than
-- preserving one, because a program wallet never had a position row to carry an
-- id from. `provider_wallet_id` is the natural key that makes it repeatable.
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO earn_positions (
    id, organization_id, project_id, environment, provider, kind,
    provider_wallet_id, label, created_by, created_at, updated_at, activated_at
)
SELECT
    'earn_position_' || gen_random_uuid(),
    projected.organization_id,
    projected.project_id,
    projected.environment,
    projected.provider,
    projected.kind,
    projected.provider_wallet_id,
    projected.label,
    projected.created_by,
    projected.created_at,
    projected.updated_at,
    projected.activated_at
FROM earn_projected_position_from_provider_wallet projected
WHERE NOT EXISTS (
    SELECT 1
    FROM earn_positions existing
    WHERE existing.provider_wallet_id = projected.provider_wallet_id
      AND existing.kind = 'custodial'
)
ON CONFLICT DO NOTHING;

INSERT INTO earn_positions (
    id, organization_id, project_id, environment, provider, kind,
    custody_wallet_id, vault_address, share_mint, token_mint,
    label, created_by, created_at, updated_at, activated_at, closed_at
)
SELECT
    id, organization_id, project_id, environment, provider, kind,
    custody_wallet_id, vault_address, share_mint, token_mint,
    label, created_by, created_at, updated_at, activated_at, closed_at
FROM earn_projected_position_from_vault_position
ON CONFLICT (id) DO NOTHING;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. Movement history.
-- ───────────────────────────────────────────────────────────────────────────
INSERT INTO earn_movements (
    id, organization_id, project_id, environment, provider,
    execution_model, direction, position_id, status,
    failure_reason, settled_at,
    denomination, amount_requested, amount_settled, fee_amount, payout_token,
    destination_address, provider_reference,
    request_id, idempotency_fingerprint, provider_data,
    created_by, initiated_by_key_id, created_at, updated_at
)
SELECT
    id, organization_id, project_id, environment, provider,
    execution_model, direction, position_id, status,
    failure_reason, settled_at,
    denomination, amount_requested, amount_settled, fee_amount, payout_token,
    destination_address, provider_reference,
    request_id, idempotency_fingerprint, provider_data,
    created_by, initiated_by_key_id, created_at, updated_at
FROM earn_projected_movement_from_withdrawal
ON CONFLICT (id) DO NOTHING;

INSERT INTO earn_movements (
    id, organization_id, project_id, environment, provider,
    execution_model, direction, position_id, status,
    failure_reason, confirmed_at,
    denomination, amount_requested, amount_settled, min_shares_out, shares_out,
    custody_wallet_id, vault_address, source_address, destination_address,
    signature, signed_transaction, last_valid_block_height,
    request_id, idempotency_fingerprint,
    created_by, initiated_by_key_id, created_at, updated_at
)
SELECT
    id, organization_id, project_id, environment, provider,
    execution_model, direction, position_id, status,
    failure_reason, confirmed_at,
    denomination, amount_requested, amount_settled, min_shares_out, shares_out,
    custody_wallet_id, vault_address, source_address, destination_address,
    signature, signed_transaction, last_valid_block_height,
    request_id, idempotency_fingerprint,
    created_by, initiated_by_key_id, created_at, updated_at
FROM earn_projected_movement_from_vault_movement
ON CONFLICT (id) DO NOTHING;
