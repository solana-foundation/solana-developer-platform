-- sdp:migration-mode: non-transactional
-- HOO-2303: bound retention scans as history grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_alerts_retention
    ON admin_alerts (created_at, id)
    WHERE details->>'actor' IS NOT NULL OR details->>'subject' IS NOT NULL;
