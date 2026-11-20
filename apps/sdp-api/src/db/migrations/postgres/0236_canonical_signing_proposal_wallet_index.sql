-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS custody_proposals_signing_wallet_idx
  ON custody_proposals (organization_id, project_id, custody_wallet_id, created_at DESC, id DESC)
  WHERE kind = 'signing';
