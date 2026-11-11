-- sdp:migration-mode: non-transactional
-- HOO-2303: bound retention scans as history grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS admin_alert_deliveries_retention
    ON admin_alert_deliveries (created_at, alert_id, user_id)
    WHERE email NOT LIKE '%@deleted.invalid';
