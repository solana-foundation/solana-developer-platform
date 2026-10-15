-- The Idempotency-Key backstop for custody wallet creation (HOO-1918).
--
-- A wallet create calls a custody provider. The shared idempotency_keys record
-- is a lease: if the process dies after the provider made the wallet, or the
-- lease is taken over, a retry runs the handler again. The wallet row keeps
-- the request id derived from the key (scoped by organization, project and
-- credential, so it never collides across tenants) and the request's
-- fingerprint, so that retry finds this row instead of creating a second
-- provider wallet. The same id is sent to providers that dedupe on one.
-- Rows created before this migration, and unkeyed creates, have none; the
-- index ignores them.
--
-- sdp:migration-locks: blocking
-- The unique index builds without CONCURRENTLY and briefly blocks writes to
-- `custody_wallets`. That is harmless here: production has never run these tables (the
-- platform is pre-launch), so they are near empty when the index builds, and a
-- concurrent build would need its own non-transactional file per index.

ALTER TABLE custody_wallets
    ADD COLUMN IF NOT EXISTS idempotency_request_id TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS custody_wallets_idempotency_request_id_idx
    ON custody_wallets(idempotency_request_id)
    WHERE idempotency_request_id IS NOT NULL;

-- A keyed row carries both its request id and its fingerprint; an unkeyed row neither.
-- Dropped first so the file re-runs cleanly where it already applied under its
-- earlier names, as every statement here does.
ALTER TABLE custody_wallets
    DROP CONSTRAINT IF EXISTS custody_wallets_idempotency_pair_check;
ALTER TABLE custody_wallets
    ADD CONSTRAINT custody_wallets_idempotency_pair_check
    CHECK ((idempotency_request_id IS NULL) = (idempotency_fingerprint IS NULL));
