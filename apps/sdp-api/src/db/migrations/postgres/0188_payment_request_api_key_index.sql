-- sdp:migration-mode: non-transactional
--
-- Revoke-and-cancel finds a key's open requests by created_by_api_key_id (0186); partial, since
-- most requests are created by a member or not open. CONCURRENTLY because payment_requests is
-- live.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_requests_awaiting_created_by_api_key
    ON payment_requests (created_by_api_key_id)
    WHERE status = 'awaiting_payment' AND created_by_api_key_id IS NOT NULL;
