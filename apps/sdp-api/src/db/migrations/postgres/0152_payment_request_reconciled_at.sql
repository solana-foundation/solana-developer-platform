-- When the payment-request reconciler last checked a request's reference on
-- chain. The sweep takes the least recently checked open requests first, a
-- never-checked one queued by its creation time, so every open request is
-- checked in turn instead of the same batch every run.
ALTER TABLE payment_requests ADD COLUMN IF NOT EXISTS reconciled_at TEXT;
