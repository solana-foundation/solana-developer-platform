-- sdp:migration-mode: non-transactional
-- Build on the live ledger without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_project_status_created_id
    ON payment_transfers(project_id, status, created_at DESC, id DESC);
