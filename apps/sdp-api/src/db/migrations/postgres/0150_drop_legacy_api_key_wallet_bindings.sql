-- sdp:migration-compat: breaking
-- Wallet scope at signing (HOO-2099): an API key's wallets are
-- api_keys.wallet_scope and api_key_signing_wallets (0143). Nothing reads or
-- writes the per-wallet permission bindings or the default signing wallet
-- since then, so they go. Pre-launch: no traffic rollback needs them.
DROP TABLE api_key_wallet_permissions;

DROP INDEX IF EXISTS idx_api_keys_signing_wallet_id;
ALTER TABLE api_keys DROP COLUMN signing_wallet_id;
