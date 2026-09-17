-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issuance_transactions_organization_created_id ON issuance_transactions(organization_id, created_at DESC, id DESC);
