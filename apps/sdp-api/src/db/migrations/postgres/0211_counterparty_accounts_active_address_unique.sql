-- sdp:migration-mode: non-transactional
-- HOO-2618: at most one active crypto_wallet account per counterparty, network
-- and address, so two concurrent creates cannot both insert one. Archived
-- accounts are outside the index: archiving is terminal, and re-adding an
-- archived address creates a new account. Older rows keep the address only in
-- `details`, so the key falls back to the JSON. No environment held duplicates
-- when this shipped (prod was not live); a database that does fails the build
-- until the extra accounts are archived. Built CONCURRENTLY because
-- counterparty_accounts is live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS counterparty_accounts_active_address_unique ON counterparty_accounts(counterparty_id, (COALESCE(network, details->>'network')), (COALESCE(address, details->>'address'))) WHERE status = 'active' AND account_kind = 'crypto_wallet';
