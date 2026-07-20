-- sdp:migration-mode: non-transactional
-- Supports address-scoped inbound ledger reads without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_project_destination_created_id
    ON payment_transfers(project_id, destination_address, created_at DESC, id DESC);
