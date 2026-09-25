-- sdp:migration-mode: non-transactional
-- Poll-queue index for confirmed issuance transactions (column added by
-- migration 0119). Built concurrently, mirroring migration 0105, so a
-- sizeable live issuance table is not paused behind a lock-holding build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issuance_tx_finalization_poll
    ON issuance_transactions (finalization_last_polled_at ASC NULLS FIRST, id ASC)
 WHERE status = 'confirmed';
