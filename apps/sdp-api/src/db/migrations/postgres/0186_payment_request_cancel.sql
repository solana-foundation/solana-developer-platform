-- A merchant cancels an open payment request (SOLA9-762), and revoking an API key cancels the
-- open requests that key created. canceled_at anchors the late-payment watch: a payer who
-- signed before the cancel can still land the transfer, and the reconciler records it as paid
-- late. created_by_api_key_id names the key behind an API-created request; created_by holds the
-- key creator's user id and cannot tell keys apart. Rows from before this change stay NULL.
ALTER TABLE payment_requests
    ADD COLUMN IF NOT EXISTS canceled_at TEXT,
    ADD COLUMN IF NOT EXISTS created_by_api_key_id TEXT;
-- Their indexes build concurrently in 0187.

-- A canceled request that a late payment settles keeps who canceled it and when, so the CHECK
-- widens to `paid`. Widening is a drop and re-add that refuses nothing the previous image
-- writes; the cancel shape is new and constrains columns that image never sets. Both go back
-- NOT VALID so the add takes no blocking scan, and 0188 validates them.
ALTER TABLE payment_requests
    DROP CONSTRAINT payment_requests_canceled_by_only_when_canceled,
    ADD CONSTRAINT payment_requests_canceled_by_only_when_canceled
    CHECK (canceled_by IS NULL OR status IN ('canceled', 'paid')) NOT VALID,
    ADD CONSTRAINT payment_requests_cancel_shape
    CHECK (
        (canceled_at IS NULL) = (canceled_by IS NULL)
        AND (status != 'canceled' OR canceled_at IS NOT NULL)
    ) NOT VALID;
