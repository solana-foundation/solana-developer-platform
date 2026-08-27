-- Stop keeping a history of connection checks (HOO-1228).
--
-- The check is now run when a connection is saved and on demand afterwards, so
-- the stored result was only ever a stale copy of something we can ask the
-- provider for directly. Zach's note on the feedback thread: "Don't need to
-- store testing connection data. Just test during add time, and a subtle
-- connection test afterwards that's on trigger."
--
-- Only `rpc_connections` is touched here. `custody_connections` carries
-- identically-named columns for a different provider family and a different
-- lifecycle; they stay.

ALTER TABLE rpc_connections
    DROP CONSTRAINT IF EXISTS rpc_connections_last_check_status_check;

ALTER TABLE rpc_connections
    DROP COLUMN IF EXISTS last_check_status,
    DROP COLUMN IF EXISTS last_check_at,
    DROP COLUMN IF EXISTS last_check_failure_code;
