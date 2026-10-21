-- sdp:migration-mode: non-transactional
-- Serve the reconciler's least-recently-checked-first read of open payment
-- requests from one ordered range over open rows only.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_reconcile_due
  ON payment_requests (reconciled_at ASC NULLS FIRST, id ASC)
  WHERE status = 'awaiting_payment';
