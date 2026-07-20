-- sdp:migration-mode: non-transactional
-- Build on the live ledger without blocking writes.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_project_wallet_created_id
    ON payment_transfers(project_id, wallet_id, created_at DESC, id DESC);
