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

ALTER TABLE custody_wallets
    ADD COLUMN IF NOT EXISTS idempotency_request_id TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS custody_wallets_idempotency_request_id_idx
    ON custody_wallets(idempotency_request_id)
    WHERE idempotency_request_id IS NOT NULL;

-- A keyed row carries both its request id and its fingerprint; an unkeyed row neither.
ALTER TABLE custody_wallets
    ADD CONSTRAINT custody_wallets_idempotency_pair_check
    CHECK ((idempotency_request_id IS NULL) = (idempotency_fingerprint IS NULL));
