-- A merchant cancels an open payment request (SOLA9-762). canceled_at anchors the late-payment
-- watch: a payer who signed before the cancel can still land the transfer, and the reconciler
-- records it as paid late. Rows from before this change stay NULL.
--
-- Who canceled is the principal that authenticated the cancel: an API key or a member, never
-- both, and never the key's creator in its place. The legacy canceled_by column is no longer
-- written; a later contraction drops it.
ALTER TABLE payment_requests
    ADD COLUMN IF NOT EXISTS canceled_at TEXT,
    ADD COLUMN IF NOT EXISTS canceled_by_api_key_id TEXT,
    ADD COLUMN IF NOT EXISTS canceled_by_user_id TEXT;
-- canceled_at's index builds concurrently in 0187.

-- A canceled request names exactly one canceler, and kept through a late payment to `paid`; an
-- uncanceled one names none. The previous image writes none of these columns, so it satisfies
-- the CHECK. Added NOT VALID so the add takes no blocking scan; 0188 validates it.
ALTER TABLE payment_requests
    ADD CONSTRAINT payment_requests_canceled_by_principal_check
    CHECK (
        num_nonnulls(canceled_by_api_key_id, canceled_by_user_id)
            = CASE WHEN canceled_at IS NULL THEN 0 ELSE 1 END
    ) NOT VALID;
