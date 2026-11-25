-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS custody_wallets_policy_check_queue_idx
    ON custody_wallets (policy_check_claimed_at ASC NULLS FIRST, id)
    WHERE custody_connection_id IS NOT NULL AND status = 'active';
