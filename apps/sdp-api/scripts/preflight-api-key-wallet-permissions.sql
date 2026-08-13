-- Run read-only before deploying migration 0057.
-- Keep PRIVY_BYOK_ENABLED off until:
--   1. zero_match_permissions, ambiguous_permissions, and
--      signing_wallet_without_permission are all zero or each affected key has
--      an explicitly reviewed owner-approved repair;
--   2. every old API revision that authorizes by Provider wallet_id has drained;
--   3. API-key authorization caches have been invalidated or allowed to expire.
-- Unique matches are backfilled by migration 0057. Never delete an unresolved
-- permission row: its presence keeps the key selected and fail-closed.
WITH eligible_wallets AS (
    SELECT api_key.id AS api_key_id, wallet.id AS custody_wallet_id, wallet.wallet_id
    FROM api_keys api_key
    JOIN custody_configs config
      ON config.organization_id = api_key.organization_id
     AND (config.project_id IS NULL OR config.project_id = api_key.project_id)
     AND config.status = 'active'
    JOIN custody_wallets wallet
      ON wallet.custody_config_id = config.id
     AND wallet.status = 'active'

    UNION ALL

    SELECT api_key.id, wallet.id, wallet.wallet_id
    FROM api_keys api_key
    JOIN custody_connections connection
      ON connection.organization_id = api_key.organization_id
     AND connection.project_id = api_key.project_id
     AND connection.status = 'active'
    JOIN custody_wallets wallet
      ON wallet.custody_connection_id = connection.id
     AND wallet.status = 'active'
), permission_matches AS (
    SELECT permission.id, COUNT(DISTINCT eligible.custody_wallet_id) AS match_count
    FROM api_key_wallet_permissions permission
    LEFT JOIN eligible_wallets eligible
      ON eligible.api_key_id = permission.api_key_id
     AND eligible.wallet_id = permission.wallet_id
    GROUP BY permission.id
)
SELECT
    COUNT(*) FILTER (WHERE match_count = 0) AS zero_match_permissions,
    COUNT(*) FILTER (WHERE match_count = 1) AS unique_match_permissions,
    COUNT(*) FILTER (WHERE match_count > 1) AS ambiguous_permissions,
    (
        SELECT COUNT(*)
        FROM api_keys api_key
        WHERE api_key.signing_wallet_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM api_key_wallet_permissions permission
              WHERE permission.api_key_id = api_key.id
          )
    ) AS signing_wallet_without_permission
FROM permission_matches;

-- Review these rows with their owners before enablement. Resolve ambiguity in
-- the underlying wallet ownership, then replace bindings through the existing
-- API; use direct data repair only after explicit review.
WITH eligible_wallets AS (
    SELECT api_key.id AS api_key_id, wallet.id AS custody_wallet_id, wallet.wallet_id
    FROM api_keys api_key
    JOIN custody_configs config
      ON config.organization_id = api_key.organization_id
     AND (config.project_id IS NULL OR config.project_id = api_key.project_id)
     AND config.status = 'active'
    JOIN custody_wallets wallet
      ON wallet.custody_config_id = config.id
     AND wallet.status = 'active'

    UNION ALL

    SELECT api_key.id, wallet.id, wallet.wallet_id
    FROM api_keys api_key
    JOIN custody_connections connection
      ON connection.organization_id = api_key.organization_id
     AND connection.project_id = api_key.project_id
     AND connection.status = 'active'
    JOIN custody_wallets wallet
      ON wallet.custody_connection_id = connection.id
     AND wallet.status = 'active'
), permission_matches AS (
    SELECT
        permission.id AS permission_id,
        permission.api_key_id,
        permission.wallet_id,
        COUNT(DISTINCT eligible.custody_wallet_id) AS match_count,
        ARRAY_AGG(DISTINCT eligible.custody_wallet_id)
            FILTER (WHERE eligible.custody_wallet_id IS NOT NULL) AS custody_wallet_ids
    FROM api_key_wallet_permissions permission
    LEFT JOIN eligible_wallets eligible
      ON eligible.api_key_id = permission.api_key_id
     AND eligible.wallet_id = permission.wallet_id
    GROUP BY permission.id, permission.api_key_id, permission.wallet_id
)
SELECT permission_id, api_key_id, wallet_id, match_count, custody_wallet_ids
FROM permission_matches
WHERE match_count <> 1
ORDER BY api_key_id, permission_id;

SELECT api_key.id AS api_key_id, api_key.signing_wallet_id
FROM api_keys api_key
WHERE api_key.signing_wallet_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM api_key_wallet_permissions permission
      WHERE permission.api_key_id = api_key.id
  )
ORDER BY api_key.id;
