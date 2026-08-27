-- One live connection per provider, per project, per network.
--
-- `submitRpcConnection` already refuses a second key for a provider, but it
-- does so by reading `countLiveConnections` first, and an unlocked read cannot
-- stop two concurrent saves from both seeing zero.
--
-- The existing `rpc_connections_one_default_per_scope_network` guards the
-- serving slot, not the provider, so it only caught the race when both saves
-- tried to serve. Once a project could hold a key per provider, a save landing
-- while some *other* provider was already serving set `is_default = FALSE`,
-- touched no unique index, and both rows persisted. The UI labels rows by
-- credential name, so the duplicate is indistinguishable, unreachable through
-- the rotation flow, and confusing to support.
--
-- Deactivated rows are excluded so withdrawn history keeps its place without
-- competing, exactly as the default-slot index does.

-- Belt and braces before the constraint. The window only opened when a project
-- gained the ability to hold a key per provider, so this should match nothing;
-- it exists so the migration cannot fail on a database where it does. The
-- survivor is the serving row if there is one, otherwise the newest, which is
-- the row the dashboard was already showing as this provider's key.
WITH ranked AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY organization_id, scope_key, network, provider
            ORDER BY is_default DESC, created_at DESC, id DESC
        ) AS position
    FROM rpc_connections
    WHERE status <> 'deactivated'
)
UPDATE rpc_connections AS c
   SET status = 'deactivated',
       is_default = FALSE,
       deactivated_at = COALESCE(c.deactivated_at, sdp_iso_now()),
       updated_at = sdp_iso_now()
  FROM ranked
 WHERE ranked.id = c.id
   AND ranked.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS rpc_connections_one_live_per_provider
    ON rpc_connections (organization_id, scope_key, network, provider)
    WHERE status <> 'deactivated';
