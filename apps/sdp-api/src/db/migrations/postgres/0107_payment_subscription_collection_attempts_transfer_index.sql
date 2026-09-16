-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_subscription_collection_attempts_transfer_id ON payment_subscription_collection_attempts(transfer_id);
