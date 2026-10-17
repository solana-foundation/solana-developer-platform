-- Grants by module (HOO-2099): the actions (`module.verb`) an API key holds,
-- an explicit list with no role and no wildcard. Authentication reads only
-- this column; role, permissions and allowed_operations are no longer read and
-- are dropped by a later migration. Existing keys start with no grants, so
-- they authorize nothing until edited (every pre-launch key is revoked anyway,
-- HOO-1890).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS grants text[] NOT NULL DEFAULT '{}';
