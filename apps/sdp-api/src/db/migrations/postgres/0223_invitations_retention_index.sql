-- sdp:migration-mode: non-transactional
-- HOO-2303: bound retention scans as history grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS invitations_retention
    ON invitations (expires_at, id)
    WHERE pii_pseudonymized_at IS NULL
      AND email NOT LIKE '%@users.invalid';
