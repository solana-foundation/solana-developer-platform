-- sdp:migration-compat: breaking
-- Grants by module (HOO-2099): an API key's authority is api_keys.grants
-- alone. Nothing reads or writes role, permissions or allowed_operations
-- since 0142, so they go. Pre-launch: no traffic rollback needs them.
ALTER TABLE api_keys
    DROP COLUMN role,
    DROP COLUMN permissions,
    DROP COLUMN allowed_operations;
