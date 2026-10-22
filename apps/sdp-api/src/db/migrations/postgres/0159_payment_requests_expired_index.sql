-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_expired_expires_at
    ON payment_requests (expires_at)
    WHERE status = 'expired';
