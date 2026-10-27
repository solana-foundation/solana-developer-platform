-- sdp:migration-mode: non-transactional
-- HOO-2335 (SDP-021 SA-2): a batch externalId names one payout run per source
-- wallet, so a resend under a new Idempotency-Key cannot pay the run twice.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfer_batches_project_wallet_external_id
    ON payment_transfer_batches (project_id, source_custody_wallet_id, external_id)
    WHERE external_id IS NOT NULL;
