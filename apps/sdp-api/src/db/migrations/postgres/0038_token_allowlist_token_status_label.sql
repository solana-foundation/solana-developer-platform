-- sdp:migration-mode: non-transactional
-- Backs the exact label filter and the DISTINCT label facet on the control list.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_token_allowlist_token_status_label
    ON token_allowlists (token_id, status, label);
