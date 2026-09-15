-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_movements_organization_created_id ON earn_movements(organization_id, created_at DESC, id DESC);
