-- sdp:migration-mode: non-transactional
-- Keeps contains-style free-text search indexed as the ledger grows.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_transfers_search_trgm
    ON payment_transfers USING GIN ((
        id || ' ' ||
        COALESCE(signature, '') || ' ' ||
        COALESCE(provider_reference, '') || ' ' ||
        COALESCE(source_address, '') || ' ' ||
        COALESCE(destination_address, '') || ' ' ||
        COALESCE(memo, '') || ' ' ||
        COALESCE(counterparty_id, '')
    ) gin_trgm_ops);
