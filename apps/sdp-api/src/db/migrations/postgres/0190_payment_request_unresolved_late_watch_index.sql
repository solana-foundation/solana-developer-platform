-- sdp:migration-mode: non-transactional
-- Keep old unresolved payment candidates in the late watch without scanning all closed requests.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_unresolved_late_watch
    ON payment_requests (last_checked_at, id)
    WHERE status IN ('expired', 'canceled')
      AND signature_scan_stuck_signature IS NOT NULL
      AND custody_wallet_id IS NOT NULL;
