-- sdp:migration-mode: non-transactional
-- Keeps contains-style search over control-list address + label indexed as the list grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_allowlist_search_trgm
    ON token_allowlists USING GIN ((address || ' ' || COALESCE(label, '')) gin_trgm_ops);
