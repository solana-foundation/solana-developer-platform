-- A merchant cancels an open payment request (SOLA9-762). canceled_at anchors the late-payment
-- watch: a payer who signed before the cancel can still land the transfer, and the reconciler
-- records it as paid late. Rows from before this change stay NULL.
ALTER TABLE payment_requests
    ADD COLUMN IF NOT EXISTS canceled_at TEXT;
-- Its index builds concurrently in 0187.

-- A canceled request that a late payment settles keeps who canceled it, so the canceled_by
-- CHECK widens to `paid`. Widening is a drop and re-add that refuses nothing the previous image
-- writes; it goes back NOT VALID so the add takes no blocking scan, and 0188 validates it.
ALTER TABLE payment_requests
    DROP CONSTRAINT payment_requests_canceled_by_only_when_canceled,
    ADD CONSTRAINT payment_requests_canceled_by_only_when_canceled
    CHECK (canceled_by IS NULL OR status IN ('canceled', 'paid')) NOT VALID;
