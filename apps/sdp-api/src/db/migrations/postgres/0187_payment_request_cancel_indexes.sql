-- sdp:migration-mode: non-transactional
--
-- The late-payment watch scans canceled requests by canceled_at (0186), as it scans expired
-- ones by expires_at (0170). Revoke-and-cancel finds a key's open requests by
-- created_by_api_key_id; partial, since most requests are created by a member or not open.
-- CONCURRENTLY because payment_requests is live.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_canceled_canceled_at
    ON payment_requests (canceled_at)
    WHERE status = 'canceled';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_awaiting_created_by_api_key
    ON payment_requests (created_by_api_key_id)
    WHERE status = 'awaiting_payment' AND created_by_api_key_id IS NOT NULL;
