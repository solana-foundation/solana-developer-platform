-- sdp:migration-mode: non-transactional
-- Keeps counterparty-name ledger search indexed as the directory grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_counterparties_display_name_trgm
    ON counterparties USING GIN (display_name gin_trgm_ops);
