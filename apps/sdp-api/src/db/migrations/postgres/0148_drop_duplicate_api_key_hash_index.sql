-- sdp:migration-compat: breaking
-- api_keys.key_hash is UNIQUE (0001), so its unique index already serves the
-- authentication lookup by hash (HOO-2099); idx_api_keys_hash is a second
-- btree over the same column that only costs writes. No code names it.
DROP INDEX IF EXISTS idx_api_keys_hash;
