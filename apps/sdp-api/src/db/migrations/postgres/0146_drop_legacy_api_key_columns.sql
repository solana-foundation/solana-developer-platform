-- sdp:migration-compat: breaking
-- Grants by module (HOO-2099): an API key's authority is api_keys.grants
-- alone. Nothing reads or writes role, permissions or allowed_operations
-- since 0142, so they go. Pre-launch: no traffic rollback needs them.
--
-- First, the cutover step 0142 promised: a key still unmarked
-- (grants_assigned = false) predates grants and was never given any. The
-- current revision already refuses it; deactivating it means the previous
-- revision does too, so no rollback hands it its old role back. A person
-- who still needs it creates a new key.
UPDATE api_keys
   SET status = 'deactivated', revoked_at = sdp_iso_now()
 WHERE status = 'active' AND NOT grants_assigned;

ALTER TABLE api_keys
    DROP COLUMN role,
    DROP COLUMN permissions,
    DROP COLUMN allowed_operations;
