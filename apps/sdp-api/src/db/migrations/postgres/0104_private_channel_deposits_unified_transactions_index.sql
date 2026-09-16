-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_private_channel_deposits_organization_created_id ON private_channel_deposits(organization_id, created_at DESC, id DESC);
