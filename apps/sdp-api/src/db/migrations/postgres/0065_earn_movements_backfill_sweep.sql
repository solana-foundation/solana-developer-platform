-- Solana Earn: re-run the movement backfill, now that reads serve from the
-- unified ledger (PRO-1705).
--
-- ── Why the same projection runs twice ────────────────────────────────────
-- Migrations apply BEFORE the new revision serves traffic. So between 0064
-- finishing and the revision that dual-writes taking over, the OUTGOING revision
-- was still writing the legacy tables alone — and those rows reached neither that
-- backfill pass nor the mirror. The same window opens again for any rollback that
-- briefly restored a legacy-only writer.
--
-- Every row written in such a window is invisible to the reads this release
-- switches over, which is the one way this migration could lose a money movement
-- from history. Running the identical projection again closes it: the statements
-- are `ON CONFLICT DO NOTHING` keyed on the legacy row's own id, so rows already
-- present are untouched and only the gap is filled.
--
-- Deliberately a copy of 0064 rather than a shared file: a migration is a record
-- of what ran at a point in time, and the runner ledgers it by filename. Editing
-- 0064 to run twice would rewrite applied history; re-stating it says plainly
-- that the same projection ran again, and when.
--
-- The mapping itself still lives in 0063's views, so this cannot drift from
-- either the first pass or the application's dual-write.

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Holdings first — both movement projections join a position.
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
