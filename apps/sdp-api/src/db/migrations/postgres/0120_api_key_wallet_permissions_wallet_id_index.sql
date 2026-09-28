-- sdp:migration-mode: non-transactional
--
-- The API-key provisioning retry lookup (migration 0119) guards each candidate
-- wallet with two anti-joins: no api_keys row points at the wallet and no
-- api_key_wallet_permissions row binds it. api_keys.signing_wallet_id is
-- indexed; api_key_wallet_permissions.wallet_id is not, so every candidate
-- probe scanned the whole bindings table. Index the wallet side so a retry
-- request with candidates pending probes this table in O(log n) instead of a
-- full scan.
--
-- CONCURRENTLY avoids blocking API-key traffic while Postgres builds the index
-- over the live bindings table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_api_key_wallet_permissions_wallet
    ON api_key_wallet_permissions(wallet_id);
