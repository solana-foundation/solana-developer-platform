-- Grants by module (HOO-2099): the actions (`module.verb`) an API key holds,
-- an explicit list with no role and no wildcard. Authentication reads only
-- this column; role, permissions and allowed_operations are no longer read and
-- are dropped by a later migration.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS grants text[] NOT NULL DEFAULT '{}';

-- Whether a person has given the key its grants. A key that predates them
-- has none, and nothing maps a role to grants (that would be guesswork), so
-- authentication refuses it with REVOKED_API_KEY instead of letting it fail
-- every route; setting its grants marks it. 0143 deactivates every key still
-- unmarked before it drops the legacy columns, so no rollback can revive one.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS grants_assigned boolean NOT NULL DEFAULT true;

-- backfill:start
UPDATE api_keys SET grants_assigned = false;
-- backfill:end
