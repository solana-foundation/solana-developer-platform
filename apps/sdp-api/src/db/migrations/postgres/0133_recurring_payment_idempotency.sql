-- The Idempotency-Key backstop for recurring payments (HOO-1918).
--
-- The shared idempotency_keys record expires after 24 hours. A recurring
-- payment is a commitment to move money later, so its row keeps the key under
-- a unique index as well: a retry after the 24 hours, or after a 5xx on a route
-- that re-runs, finds this row instead of creating a second schedule.
-- Rows created before this migration have no key; the index ignores them.

ALTER TABLE payment_recurring_payments
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payment_recurring_payments_idempotency_key_idx
    ON payment_recurring_payments(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
