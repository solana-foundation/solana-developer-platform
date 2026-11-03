-- sdp:migration-mode: non-transactional
-- Keep the Privy index for older revisions; build this without blocking wallet setup.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_custody_connections_fireblocks_unfinished
    ON custody_connections(organization_id, project_id, provider)
    WHERE provider = 'fireblocks' AND project_id IS NOT NULL
      AND status IN ('pending', 'checking');
