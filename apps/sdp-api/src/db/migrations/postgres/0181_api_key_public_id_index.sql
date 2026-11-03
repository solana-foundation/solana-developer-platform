-- sdp:migration-mode: non-transactional
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_api_keys_public_id
    ON api_keys (public_id)
    WHERE public_id IS NOT NULL;
