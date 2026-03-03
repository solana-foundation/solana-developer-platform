CREATE TABLE IF NOT EXISTS api_key_wallet_permissions (
  id TEXT PRIMARY KEY,
  api_key_id TEXT NOT NULL,
  wallet_id TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '["*"]',
  created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_wallet_permissions_key_wallet
  ON api_key_wallet_permissions(api_key_id, wallet_id);

CREATE INDEX IF NOT EXISTS idx_api_key_wallet_permissions_key
  ON api_key_wallet_permissions(api_key_id);

INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
SELECT
  'akw_' || lower(hex(randomblob(16))),
  api_keys.id,
  api_keys.signing_wallet_id,
  '["*"]'
FROM api_keys
WHERE api_keys.signing_wallet_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM api_key_wallet_permissions p
    WHERE p.api_key_id = api_keys.id
      AND p.wallet_id = api_keys.signing_wallet_id
  );
