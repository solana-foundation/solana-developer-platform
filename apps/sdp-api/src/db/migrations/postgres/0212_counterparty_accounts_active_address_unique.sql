-- sdp:migration-mode: non-transactional
-- HOO-2618: at most one active crypto_wallet account per counterparty, network
-- and address, so two concurrent creates cannot both insert one. Archived
-- accounts are outside the index: archiving is terminal, and re-adding an
-- archived address creates a new account. Older rows keep the address only in
-- `details`, so the key falls back to the JSON. 0211 archived the duplicates
-- this would reject. Built CONCURRENTLY because counterparty_accounts is live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS counterparty_accounts_active_address_unique ON counterparty_accounts(counterparty_id, (COALESCE(network, details->>'network')), (COALESCE(address, details->>'address'))) WHERE status = 'active' AND account_kind = 'crypto_wallet';
