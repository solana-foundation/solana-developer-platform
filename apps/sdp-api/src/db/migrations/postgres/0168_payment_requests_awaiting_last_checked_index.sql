-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_awaiting_last_checked
    ON payment_requests (last_checked_at ASC NULLS FIRST, created_at ASC, id ASC)
    WHERE status = 'awaiting_payment';
