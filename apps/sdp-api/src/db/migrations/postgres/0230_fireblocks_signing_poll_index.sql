-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_fireblocks_signing_pending_poll
  ON fireblocks_signing_proposals (updated_at, id) WHERE finished_at IS NULL;
