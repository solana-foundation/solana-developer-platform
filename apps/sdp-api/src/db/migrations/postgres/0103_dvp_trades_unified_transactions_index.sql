-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dvp_trades_organization_created_id ON dvp_trades(organization_id, created_at DESC, id DESC);
