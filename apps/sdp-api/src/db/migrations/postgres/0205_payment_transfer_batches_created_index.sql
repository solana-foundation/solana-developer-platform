-- sdp:migration-mode: non-transactional
-- HOO-2299: the admin money-movement digest counts every organization's batches created in one
-- window. Built CONCURRENTLY because payment_transfer_batches is live.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfer_batches_created
    ON payment_transfer_batches (created_at);
