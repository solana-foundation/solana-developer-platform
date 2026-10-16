-- The Idempotency-Key backstop for recurring payments (HOO-1918).
--
-- The shared idempotency_keys record expires after 24 hours. A recurring
-- payment is a commitment to move money later, so its row keeps the key under
-- a unique index as well: a retry after the 24 hours, or after a 5xx on a route
-- that re-runs, finds this row instead of creating a second schedule.
-- Rows created before this migration have no key; the index ignores them.
--
-- sdp:migration-locks: blocking
-- The unique index builds without CONCURRENTLY and briefly blocks writes to
-- `payment_recurring_payments`. That is harmless here: production has never run these tables (the
-- platform is pre-launch), so they are near empty when the index builds, and a
-- concurrent build would need its own non-transactional file per index.

ALTER TABLE payment_recurring_payments
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payment_recurring_payments_idempotency_key_idx
    ON payment_recurring_payments(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
