-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_fulfilled_by_transfer_id ON payment_requests(fulfilled_by_transfer_id);
