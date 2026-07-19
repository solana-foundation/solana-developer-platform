-- sdp:migration-mode: non-transactional
-- Supports address-scoped outbound ledger reads without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_project_source_created_id
    ON payment_transfers(project_id, source_address, created_at DESC, id DESC);
