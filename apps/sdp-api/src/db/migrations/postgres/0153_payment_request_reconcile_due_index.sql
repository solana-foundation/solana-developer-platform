-- sdp:migration-mode: non-transactional
-- Serve the reconciler's read of open payment requests in rotation order: least
-- recently reconciled first, a never-reconciled request queued by when it was
-- created. Both columns are sdp_iso_now() text, so text order is time order.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_reconcile_due
  ON payment_requests ((COALESCE(last_checked_at, created_at)), id)
  WHERE status = 'awaiting_payment';
