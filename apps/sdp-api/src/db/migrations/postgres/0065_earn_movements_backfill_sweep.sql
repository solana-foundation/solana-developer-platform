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
-- from history. Existing rows can also be stale: the first pass may have projected
-- an intent before the outgoing revision advanced its status or position state.
-- This pass therefore UPSERTS the projection rather than merely filling missing
-- ids. The legacy row remains authoritative for every state it can express, while
-- the unified-only `finalized` state is explicitly protected below.
--
-- Deliberately a copy of 0064 rather than a shared file: a migration is a record
-- of what ran at a point in time, and the runner ledgers it by filename. Editing
-- 0064 to run twice would rewrite applied history; re-stating it says plainly
-- that the same projection ran again, and when.
--
-- The mapping itself still lives in 0063's views, so this cannot drift from
-- either the first pass or the application's dual-write. The `updated_at` guards
-- also keep a projection read before a concurrent dual-write from overwriting the
-- newer row after waiting on its conflict lock. Equality still converges because
-- `sdp_iso_now()` has millisecond precision and the legacy projection is the
-- authority for every non-finalized state.

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
ON CONFLICT (provider_wallet_id) WHERE kind = 'custodial' DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    project_id = EXCLUDED.project_id,
    environment = EXCLUDED.environment,
    provider = EXCLUDED.provider,
    kind = EXCLUDED.kind,
    label = EXCLUDED.label,
    created_by = EXCLUDED.created_by,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    activated_at = EXCLUDED.activated_at
WHERE earn_positions.updated_at <= EXCLUDED.updated_at;

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
ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    project_id = EXCLUDED.project_id,
    environment = EXCLUDED.environment,
    provider = EXCLUDED.provider,
    kind = EXCLUDED.kind,
    custody_wallet_id = EXCLUDED.custody_wallet_id,
    vault_address = EXCLUDED.vault_address,
    share_mint = EXCLUDED.share_mint,
    token_mint = EXCLUDED.token_mint,
    label = EXCLUDED.label,
    created_by = EXCLUDED.created_by,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at,
    activated_at = EXCLUDED.activated_at,
    closed_at = EXCLUDED.closed_at
WHERE earn_positions.updated_at <= EXCLUDED.updated_at;

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
ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    project_id = EXCLUDED.project_id,
    environment = EXCLUDED.environment,
    provider = EXCLUDED.provider,
    execution_model = EXCLUDED.execution_model,
    direction = EXCLUDED.direction,
    position_id = EXCLUDED.position_id,
    status = EXCLUDED.status,
    failure_reason = EXCLUDED.failure_reason,
    settled_at = EXCLUDED.settled_at,
    denomination = EXCLUDED.denomination,
    amount_requested = EXCLUDED.amount_requested,
    amount_settled = EXCLUDED.amount_settled,
    fee_amount = EXCLUDED.fee_amount,
    payout_token = EXCLUDED.payout_token,
    destination_address = EXCLUDED.destination_address,
    provider_reference = EXCLUDED.provider_reference,
    request_id = EXCLUDED.request_id,
    idempotency_fingerprint = EXCLUDED.idempotency_fingerprint,
    provider_data = EXCLUDED.provider_data,
    created_by = EXCLUDED.created_by,
    initiated_by_key_id = EXCLUDED.initiated_by_key_id,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at
WHERE earn_movements.status <> 'finalized'
  AND earn_movements.updated_at <= EXCLUDED.updated_at;

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
ON CONFLICT (id) DO UPDATE SET
    organization_id = EXCLUDED.organization_id,
    project_id = EXCLUDED.project_id,
    environment = EXCLUDED.environment,
    provider = EXCLUDED.provider,
    execution_model = EXCLUDED.execution_model,
    direction = EXCLUDED.direction,
    position_id = EXCLUDED.position_id,
    status = EXCLUDED.status,
    failure_reason = EXCLUDED.failure_reason,
    confirmed_at = EXCLUDED.confirmed_at,
    denomination = EXCLUDED.denomination,
    amount_requested = EXCLUDED.amount_requested,
    amount_settled = EXCLUDED.amount_settled,
    min_shares_out = EXCLUDED.min_shares_out,
    shares_out = EXCLUDED.shares_out,
    custody_wallet_id = EXCLUDED.custody_wallet_id,
    vault_address = EXCLUDED.vault_address,
    source_address = EXCLUDED.source_address,
    destination_address = EXCLUDED.destination_address,
    signature = EXCLUDED.signature,
    signed_transaction = EXCLUDED.signed_transaction,
    last_valid_block_height = EXCLUDED.last_valid_block_height,
    request_id = EXCLUDED.request_id,
    idempotency_fingerprint = EXCLUDED.idempotency_fingerprint,
    created_by = EXCLUDED.created_by,
    initiated_by_key_id = EXCLUDED.initiated_by_key_id,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at
WHERE earn_movements.status <> 'finalized'
  AND earn_movements.updated_at <= EXCLUDED.updated_at;

-- Reconciliation selection records a durable fairness cursor, not a work lease.
-- Keep it separate from `updated_at`, which is part of the public movement
-- representation, and order by the last attempt with creation as its fallback.
-- This prevents an RPC-null signature from monopolizing its status class without
-- starving retries behind a constant stream of newly confirmed rows.
ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS reconciliation_attempted_at TEXT;

-- The worker reserves most of its bounded RPC batch for signatures whose blockhash
-- can still expire, while guaranteeing confirmed finalization work a share. This
-- index supports both reserved scans and their active-first overflow; the older
-- created-at index remains useful to revisions that still run the pre-finalization
-- query during rollout.
CREATE INDEX IF NOT EXISTS idx_earn_movements_reconciliation_priority
    ON earn_movements (
        (status = 'confirmed'),
        (COALESCE(reconciliation_attempted_at, created_at)) ASC,
        created_at ASC,
        id ASC
    )
    WHERE execution_model = 'vault_direct'
      AND status IN ('requested', 'submitted', 'confirmed');
