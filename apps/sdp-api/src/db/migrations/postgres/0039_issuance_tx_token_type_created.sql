-- sdp:migration-mode: non-transactional
-- Backs the per-token transaction type filter with newest-first ordering.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issuance_tx_token_type_created
    ON issuance_transactions (token_id, type, created_at);
