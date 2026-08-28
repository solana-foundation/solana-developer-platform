-- Private Channels value movement: durable, tenant-scoped idempotency.
--
-- Deposits, withdrawals and member transfers each persisted a `pending` row
-- before broadcasting, which made the attempt auditable but did NOT make it
-- deduplicable: the row was keyed by a freshly generated id, so a retried or
-- concurrent request inserted a SECOND row and broadcast a SECOND transaction.
-- For a deposit that is a duplicate escrow transfer, for a withdrawal a
-- duplicate burn, and for a transfer a duplicate spend.
--
-- The reservation is the caller's `Idempotency-Key` plus a fingerprint of the
-- request that claimed it, exactly as `payment_transfers` (migration 0025) and
-- `provider_credentials` (0034) do:
--
--   * the unique index is the reservation — a concurrent duplicate loses the
--     insert and reads the winner's row instead of signing anything;
--   * the fingerprint is what makes replay safe rather than merely quiet — the
--     same key with a DIFFERENT request payload is a 409, never a silent
--     answer describing a movement the caller did not ask for.
--
-- Scope is (organization_id, project_id, idempotency_key). project_id is NOT
-- NULL on all three tables, so no COALESCE is needed (unlike payment_transfers,
-- whose project is nullable). Tenant scoping is what stops one organization's
-- key from colliding with — or probing for — another's.
--
-- Columns are nullable and the index is partial so existing history, which
-- predates the header, stays valid. The runtime requires the header on the
-- three write routes, so every NEW row carries a reservation.

ALTER TABLE private_channel_deposits
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

ALTER TABLE private_channel_deposits
    DROP CONSTRAINT IF EXISTS private_channel_deposits_idempotency_pair_check;

ALTER TABLE private_channel_deposits
    ADD CONSTRAINT private_channel_deposits_idempotency_pair_check
        CHECK (
            (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS idx_private_channel_deposits_idempotency_key
    ON private_channel_deposits(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;


ALTER TABLE private_channel_withdrawals
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

ALTER TABLE private_channel_withdrawals
    DROP CONSTRAINT IF EXISTS private_channel_withdrawals_idempotency_pair_check;

ALTER TABLE private_channel_withdrawals
    ADD CONSTRAINT private_channel_withdrawals_idempotency_pair_check
        CHECK (
            (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS idx_private_channel_withdrawals_idempotency_key
    ON private_channel_withdrawals(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;


ALTER TABLE private_channel_transfers
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

ALTER TABLE private_channel_transfers
    DROP CONSTRAINT IF EXISTS private_channel_transfers_idempotency_pair_check;

ALTER TABLE private_channel_transfers
    ADD CONSTRAINT private_channel_transfers_idempotency_pair_check
        CHECK (
            (idempotency_key IS NULL AND idempotency_fingerprint IS NULL)
            OR (idempotency_key IS NOT NULL AND idempotency_fingerprint IS NOT NULL)
        );

CREATE UNIQUE INDEX IF NOT EXISTS idx_private_channel_transfers_idempotency_key
    ON private_channel_transfers(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
