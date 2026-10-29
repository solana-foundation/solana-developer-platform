-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_awaiting_sponsored
    ON payment_requests (sponsored_tx_last_valid_block_height)
    WHERE status = 'awaiting_payment' AND sponsored_tx_last_valid_block_height IS NOT NULL;
