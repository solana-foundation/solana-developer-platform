DROP TABLE IF EXISTS sessions;

ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;
ALTER TABLE users DROP COLUMN IF EXISTS login_count;

UPDATE api_keys
SET permissions = (
  SELECT COALESCE(jsonb_agg(granted.permission), '[]'::jsonb)::text
  FROM jsonb_array_elements_text(api_keys.permissions::jsonb) AS granted(permission)
  WHERE granted.permission NOT IN ('sessions:read', 'sessions:write')
)
WHERE permissions IS NOT NULL
  AND permissions::jsonb ?| ARRAY['sessions:read', 'sessions:write'];

UPDATE api_key_wallet_permissions
SET permissions = (
  SELECT COALESCE(jsonb_agg(granted.permission), '[]'::jsonb)::text
  FROM jsonb_array_elements_text(api_key_wallet_permissions.permissions::jsonb) AS granted(permission)
  WHERE granted.permission NOT IN ('sessions:read', 'sessions:write')
)
WHERE permissions IS NOT NULL
  AND permissions::jsonb ?| ARRAY['sessions:read', 'sessions:write'];
