ALTER TABLE api_key_wallet_permissions
    ADD COLUMN IF NOT EXISTS custody_wallet_id TEXT;

ALTER TABLE api_key_wallet_permissions
    ADD CONSTRAINT api_key_wallet_permissions_custody_wallet_fkey
        FOREIGN KEY (custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE SET NULL;

-- A non-null legacy signing wallet was enforced as selected by authorization,
-- even if its permission-row write was interrupted. Preserve that restrictive
-- meaning before exact identity is resolved.
INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
SELECT
    'akw_' || md5(api_key.id || random()::text || clock_timestamp()::text),
    api_key.id,
    api_key.signing_wallet_id,
    '["*"]'
FROM api_keys api_key
WHERE api_key.signing_wallet_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM api_key_wallet_permissions permission
      WHERE permission.api_key_id = api_key.id
  );

WITH eligible_wallets AS (
    SELECT
        api_key.id AS api_key_id,
        wallet.id AS custody_wallet_id,
        wallet.wallet_id
    FROM api_keys api_key
    JOIN custody_configs config
      ON config.organization_id = api_key.organization_id
     AND (config.project_id IS NULL OR config.project_id = api_key.project_id)
     AND config.status = 'active'
    JOIN custody_wallets wallet
      ON wallet.custody_config_id = config.id
     AND wallet.status = 'active'

    UNION ALL

    SELECT
        api_key.id AS api_key_id,
        wallet.id AS custody_wallet_id,
        wallet.wallet_id
    FROM api_keys api_key
    JOIN custody_connections connection
      ON connection.organization_id = api_key.organization_id
     AND connection.project_id = api_key.project_id
     AND connection.status = 'active'
    JOIN custody_wallets wallet
      ON wallet.custody_connection_id = connection.id
     AND wallet.status = 'active'
), unique_wallet_matches AS (
    SELECT
        permission.id AS permission_id,
        MIN(eligible.custody_wallet_id) AS custody_wallet_id
    FROM api_key_wallet_permissions permission
    JOIN eligible_wallets eligible
      ON eligible.api_key_id = permission.api_key_id
     AND eligible.wallet_id = permission.wallet_id
    WHERE permission.custody_wallet_id IS NULL
    GROUP BY permission.id
    HAVING COUNT(DISTINCT eligible.custody_wallet_id) = 1
)
UPDATE api_key_wallet_permissions permission
SET custody_wallet_id = unique_wallet_matches.custody_wallet_id
FROM unique_wallet_matches
WHERE permission.id = unique_wallet_matches.permission_id;

CREATE UNIQUE INDEX idx_api_key_wallet_permissions_key_custody_wallet
    ON api_key_wallet_permissions(api_key_id, custody_wallet_id)
    WHERE custody_wallet_id IS NOT NULL;

CREATE INDEX idx_api_key_wallet_permissions_custody_wallet
    ON api_key_wallet_permissions(custody_wallet_id)
    WHERE custody_wallet_id IS NOT NULL;
