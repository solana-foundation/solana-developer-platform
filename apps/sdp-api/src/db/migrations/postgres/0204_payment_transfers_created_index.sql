-- sdp:migration-mode: non-transactional
-- HOO-2299: the admin money-movement digest reads every organization's transfers created in one
-- window; the existing created_at indexes all lead with an organization or project.
-- Built CONCURRENTLY because payment_transfers is live.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_created
    ON payment_transfers (created_at);
