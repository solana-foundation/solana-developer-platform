-- The `sf_` key's 16-hex key ID (HOO-2256), the shared Foundation key format:
-- safe to log and display, and what the API gateway's signed identity names a
-- key by. NULL on a legacy `sk_` key, which carries no ID.
--
-- pepper_version: which API_KEY_PEPPER hashed `key_hash`. The gateway imports
-- keys with it so the pepper can rotate; every key today is under version 1.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS public_id TEXT,
  ADD COLUMN IF NOT EXISTS pepper_version SMALLINT NOT NULL DEFAULT 1;
