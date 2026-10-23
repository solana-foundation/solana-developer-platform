-- The `sf_` key's 16-hex key ID (HOO-2256), the shared Foundation key format:
-- safe to log and display, and what the API gateway's signed identity names a
-- key by. NULL on a legacy `sk_` key, which carries no ID.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS public_id TEXT;
