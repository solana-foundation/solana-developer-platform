-- Solana Earn: drop the mechanism-split movement tables (PRO-1705).
--
-- The last step of expand → backfill → switch → contract. Nothing reads or writes
-- `earn_program_withdrawals`, `earn_vault_movements` or `earn_vault_positions` any
-- more: their history was projected into `earn_movements` / `earn_positions` with
-- ids preserved (0064, swept again by 0065), reads moved over, and the previous
-- release removed the code that served them.
--
-- ── Why this is alone in its own release ──────────────────────────────────
-- This is the ONE irreversible step in the whole sequence. Every other deploy can
-- be walked back by re-serving the previous revision; once these tables are gone
-- their original bytes are gone with them.
--
-- So it ships by itself, AFTER the revision that stopped writing them is live. A
-- deploy that both stopped the writes and dropped the tables would leave a
-- rollback landing on a revision that writes into tables which no longer exist —
-- every deposit and every withdrawal failing.
--
-- ── Before applying ──────────────────────────────────────────────────────
-- 1. Confirm the revision that retired the legacy writers is deployed and has
--    soaked for at least one release.
-- 2. Review the executable verification below. The migration fails closed before
--    any DROP when a legacy holding or movement is missing its unified identity,
--    or when a terminal legacy observation would be lost. Unified rows may be
--    newer because the previous release moved their lifecycle forward.
-- 3. Optional: `pg_dump` these three tables to the archived-artifact bucket.
--    Nice-to-have, not a gate. They hold devnet test activity only (fake funds,
--    internal testing; no customer or mainnet money), so there is no real-money
--    history to protect. A dump just keeps a later look at the old rows one
--    command away, and the volume is small. Skipping it is fine.
--
-- ── What goes, and what deliberately stays ───────────────────────────────
-- The four `earn_projected_*` views go WITH the tables: each one reads a table
-- being dropped, and they existed for exactly as long as two shapes did.
--
-- `earn_provider_wallets` STAYS. It models an ACCOUNT at a provider — the
-- custodial twin of `custody_wallets` — and an account is not a holding. Every
-- custodial movement reaches its program through the `earn_positions` link row,
-- and `earn_positions.provider_wallet_id` references this table, so dropping it
-- would take the ledger's own tenancy with it.
--
-- 0055 and 0059 stay as applied history; these drops are forward-only.

-- ── Executable contract gate ────────────────────────────────────────────────
-- The projection views are the same mapping 0064/0065 used for the backfill.
-- Verify through them immediately before the irreversible DROP so a missed or
-- malformed projection aborts the migration transaction. The checks compare
-- immutable identity and request facts, then preserve terminal observations.
-- They deliberately allow the unified lifecycle to be newer than the frozen
-- legacy row after the writer cutover (for example confirmed -> finalized).
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM earn_projected_position_from_provider_wallet projected
        LEFT JOIN earn_positions unified
          ON unified.provider_wallet_id = projected.provider_wallet_id
         AND unified.kind = 'custodial'
        WHERE unified.id IS NULL
           OR ROW(
                unified.organization_id,
                unified.project_id,
                unified.environment,
                unified.provider,
                unified.kind,
                unified.provider_wallet_id,
                unified.label,
                unified.created_by,
                unified.created_at,
                unified.activated_at
              ) IS DISTINCT FROM ROW(
                projected.organization_id,
                projected.project_id,
                projected.environment,
                projected.provider,
                projected.kind,
                projected.provider_wallet_id,
                projected.label,
                projected.created_by,
                projected.created_at,
                projected.activated_at
              )
    ) THEN
        RAISE EXCEPTION
            'Earn contract blocked: a legacy provider wallet is missing or malformed in earn_positions';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM earn_projected_position_from_vault_position projected
        LEFT JOIN earn_positions unified ON unified.id = projected.id
        WHERE unified.id IS NULL
           OR ROW(
                unified.organization_id,
                unified.project_id,
                unified.environment,
                unified.provider,
                unified.kind,
                unified.custody_wallet_id,
                unified.vault_address,
                unified.share_mint,
                unified.token_mint,
                unified.created_by,
                unified.created_at
              ) IS DISTINCT FROM ROW(
                projected.organization_id,
                projected.project_id,
                projected.environment,
                projected.provider,
                projected.kind,
                projected.custody_wallet_id,
                projected.vault_address,
                projected.share_mint,
                projected.token_mint,
                projected.created_by,
                projected.created_at
              )
    ) THEN
        RAISE EXCEPTION
            'Earn contract blocked: a legacy vault position is missing or malformed in earn_positions';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM earn_projected_movement_from_withdrawal projected
        LEFT JOIN earn_movements unified ON unified.id = projected.id
        WHERE unified.id IS NULL
           OR ROW(
                unified.organization_id,
                unified.project_id,
                unified.environment,
                unified.provider,
                unified.execution_model,
                unified.direction,
                unified.position_id,
                unified.denomination,
                unified.amount_requested,
                unified.payout_token,
                unified.destination_address,
                unified.request_id,
                unified.idempotency_fingerprint,
                unified.created_by,
                unified.initiated_by_key_id,
                unified.created_at
              ) IS DISTINCT FROM ROW(
                projected.organization_id,
                projected.project_id,
                projected.environment,
                projected.provider,
                projected.execution_model,
                projected.direction,
                projected.position_id,
                projected.denomination,
                projected.amount_requested,
                projected.payout_token,
                projected.destination_address,
                projected.request_id,
                projected.idempotency_fingerprint,
                projected.created_by,
                projected.initiated_by_key_id,
                projected.created_at
              )
           OR (
                projected.status IN ('completed', 'partially_completed', 'failed', 'cancelled')
                AND (
                    unified.status IS DISTINCT FROM projected.status
                    OR ROW(
                        unified.failure_reason,
                        unified.settled_at,
                        unified.amount_settled,
                        unified.fee_amount,
                        unified.provider_reference,
                        unified.provider_data
                    ) IS DISTINCT FROM ROW(
                        projected.failure_reason,
                        projected.settled_at,
                        projected.amount_settled,
                        projected.fee_amount,
                        projected.provider_reference,
                        projected.provider_data
                    )
                )
              )
    ) THEN
        RAISE EXCEPTION
            'Earn contract blocked: a legacy custodial movement is missing or malformed in earn_movements';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM earn_projected_movement_from_vault_movement projected
        LEFT JOIN earn_movements unified ON unified.id = projected.id
        WHERE unified.id IS NULL
           OR ROW(
                unified.organization_id,
                unified.project_id,
                unified.environment,
                unified.provider,
                unified.execution_model,
                unified.direction,
                unified.position_id,
                unified.denomination,
                unified.amount_requested,
                unified.min_shares_out,
                unified.custody_wallet_id,
                unified.vault_address,
                unified.source_address,
                unified.destination_address,
                unified.signature,
                unified.signed_transaction,
                unified.last_valid_block_height,
                unified.request_id,
                unified.idempotency_fingerprint,
                unified.created_by,
                unified.initiated_by_key_id,
                unified.created_at
              ) IS DISTINCT FROM ROW(
                projected.organization_id,
                projected.project_id,
                projected.environment,
                projected.provider,
                projected.execution_model,
                projected.direction,
                projected.position_id,
                projected.denomination,
                projected.amount_requested,
                projected.min_shares_out,
                projected.custody_wallet_id,
                projected.vault_address,
                projected.source_address,
                projected.destination_address,
                projected.signature,
                projected.signed_transaction,
                projected.last_valid_block_height,
                projected.request_id,
                projected.idempotency_fingerprint,
                projected.created_by,
                projected.initiated_by_key_id,
                projected.created_at
              )
           OR NOT (
                projected.status = 'requested'
                OR (
                    projected.status = 'submitted'
                    AND unified.status IN ('submitted', 'confirmed', 'finalized', 'failed')
                )
                OR (
                    projected.status = 'confirmed'
                    AND unified.status IN ('confirmed', 'finalized')
                )
                OR (projected.status = 'failed' AND unified.status = 'failed')
              )
           OR (
                projected.status = 'confirmed'
                AND ROW(
                    unified.amount_settled,
                    unified.shares_out,
                    unified.confirmed_at
                ) IS DISTINCT FROM ROW(
                    projected.amount_settled,
                    projected.shares_out,
                    projected.confirmed_at
                )
              )
           OR (
                projected.status = 'failed'
                AND unified.failure_reason IS DISTINCT FROM projected.failure_reason
              )
    ) THEN
        RAISE EXCEPTION
            'Earn contract blocked: a legacy vault movement is missing or malformed in earn_movements';
    END IF;
END $$;

DROP VIEW IF EXISTS earn_projected_movement_from_vault_movement;
DROP VIEW IF EXISTS earn_projected_movement_from_withdrawal;
DROP VIEW IF EXISTS earn_projected_position_from_vault_position;
DROP VIEW IF EXISTS earn_projected_position_from_provider_wallet;

-- Movements before holdings: earn_vault_movements carries the six-column
-- composite foreign key into earn_vault_positions.
DROP TABLE IF EXISTS earn_vault_movements;
DROP TABLE IF EXISTS earn_vault_positions;
DROP TABLE IF EXISTS earn_program_withdrawals;
