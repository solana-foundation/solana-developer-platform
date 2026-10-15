-- Idempotency-Keys on recurring-payment attempts (HOO-1918, ADR 0009).
--
-- Each lifecycle action (activate, cancel, resume, update, collect) already
-- writes an attempt row in the same transaction as its compare-and-swap claim.
-- The request's key now goes on that row, so a same-key retry after a crash
-- or a 5xx re-run is answered from it instead of finding the schedule mid-
-- transition (409) or a period already collected (400), neither of which the
-- idempotency step stores. The partial unique indexes leave failed attempts
-- out, so a failed attempt re-runs under the same key and a live one is unique.
-- Rows written before this migration have no key; the indexes ignore them.
--
-- sdp:migration-locks: blocking
-- The unique indexes build without CONCURRENTLY and briefly blocks writes to
-- the recurring attempt and collection attempt tables. That is harmless here: production has never run these tables (the
-- platform is pre-launch), so they are near empty when the index builds, and a
-- concurrent build would need its own non-transactional file per index.

ALTER TABLE payment_recurring_payment_activation_attempts
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_recurring_activation_attempts_idempotency_key_idx
    ON payment_recurring_payment_activation_attempts(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status <> 'failed';

ALTER TABLE payment_recurring_payment_lifecycle_attempts
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_recurring_lifecycle_attempts_idempotency_key_idx
    ON payment_recurring_payment_lifecycle_attempts(
        organization_id, project_id, operation, idempotency_key
    )
    WHERE idempotency_key IS NOT NULL AND status <> 'failed';

-- An update names its new terms, so the attempt keeps the fingerprint of the
-- request too: the same key with different terms is refused (422).
ALTER TABLE payment_recurring_payment_update_attempts
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_fingerprint TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_recurring_update_attempts_idempotency_key_idx
    ON payment_recurring_payment_update_attempts(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status <> 'failed';

ALTER TABLE payment_subscription_collection_attempts
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS payment_subscription_collection_attempts_idempotency_key_idx
    ON payment_subscription_collection_attempts(organization_id, project_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status IN ('pending', 'processing', 'confirmed');
