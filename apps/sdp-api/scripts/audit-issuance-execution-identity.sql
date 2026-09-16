\set ON_ERROR_STOP on

-- Read-only HOO-1023 K5a cutover and rollback audit. Retained Config and
-- Connection wallet rows participate in exact-one matching; status is not
-- filtered because retained wallet evidence remains relevant.

\echo '=== 1. Pending Issuance draft selection resolution ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), resolutions AS (
  SELECT token.id,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = token.organization_id
            AND ((wallet.owner_kind = 'config'
                  AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL))
              OR (wallet.owner_kind = 'connection'
                  AND wallet.project_id = token.project_id))
            AND wallet.wallet_id = token.signing_wallet_id) AS match_count
  FROM issued_tokens token
  WHERE token.status = 'pending'
    AND token.mint_address IS NULL
    AND token.signing_wallet_id IS NOT NULL
    AND token.signing_custody_wallet_id IS NULL
)
SELECT COUNT(*) FILTER (WHERE match_count = 1) AS resolvable_unique,
       COUNT(*) FILTER (WHERE match_count = 0) AS unresolved_zero,
       COUNT(*) FILTER (WHERE match_count > 1) AS ambiguous_multi
FROM resolutions;

\echo '=== 1a. Unpinned uniquely-resolvable pending drafts (must be zero after catch-up) ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), resolutions AS (
  SELECT token.id, token.organization_id, token.project_id, token.signing_wallet_id,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = token.organization_id
            AND ((wallet.owner_kind = 'config'
                  AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL))
              OR (wallet.owner_kind = 'connection'
                  AND wallet.project_id = token.project_id))
            AND wallet.wallet_id = token.signing_wallet_id) AS match_count
  FROM issued_tokens token
  WHERE token.status = 'pending'
    AND token.mint_address IS NULL
    AND token.signing_wallet_id IS NOT NULL
    AND token.signing_custody_wallet_id IS NULL
)
SELECT id, organization_id, project_id, signing_wallet_id
FROM resolutions
WHERE match_count = 1
ORDER BY organization_id, project_id, id
LIMIT 100;

\echo '=== 1b. Unresolved or ambiguous pending drafts (resolve before those drafts can deploy) ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), resolutions AS (
  SELECT token.id, token.organization_id, token.project_id, token.signing_wallet_id,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = token.organization_id
            AND ((wallet.owner_kind = 'config'
                  AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL))
              OR (wallet.owner_kind = 'connection'
                  AND wallet.project_id = token.project_id))
            AND wallet.wallet_id = token.signing_wallet_id) AS match_count
  FROM issued_tokens token
  WHERE token.status = 'pending'
    AND token.mint_address IS NULL
    AND token.signing_wallet_id IS NOT NULL
    AND token.signing_custody_wallet_id IS NULL
)
SELECT id, organization_id, project_id, signing_wallet_id, match_count
FROM resolutions
WHERE match_count <> 1
ORDER BY organization_id, project_id, id
LIMIT 100;

\echo '=== 2. Persisted token exact-ID disagreements (must be zero) ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
)
SELECT token.id, token.organization_id, token.project_id,
       token.signing_custody_wallet_id, token.signing_wallet_id
FROM issued_tokens token
WHERE token.signing_custody_wallet_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM wallet_scope wallet
    WHERE wallet.id = token.signing_custody_wallet_id
      AND wallet.organization_id = token.organization_id
      AND ((wallet.owner_kind = 'config'
            AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL))
        OR (wallet.owner_kind = 'connection' AND wallet.project_id = token.project_id))
      AND wallet.wallet_id = token.signing_wallet_id
  )
ORDER BY token.organization_id, token.project_id, token.id
LIMIT 100;

\echo '=== 2a. Pending draft pins incompatible with the legacy Config resolver (must be zero before rollback) ==='
WITH legacy_config_wallets AS (
  SELECT wallet.id, wallet.wallet_id,
         config.id AS config_id, config.organization_id, config.project_id,
         config.updated_at AS config_updated_at
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  WHERE wallet.status = 'active'
    AND config.status = 'active'
), resolutions AS (
  SELECT token.id, token.organization_id, token.project_id,
         token.signing_custody_wallet_id, token.signing_wallet_id,
         (
           SELECT wallet.id
           FROM legacy_config_wallets wallet
           WHERE wallet.organization_id = token.organization_id
             AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL)
             AND wallet.wallet_id = token.signing_wallet_id
           ORDER BY CASE WHEN wallet.project_id = token.project_id THEN 0 ELSE 1 END,
                    wallet.config_updated_at DESC,
                    wallet.config_id DESC
           LIMIT 1
         ) AS legacy_custody_wallet_id
  FROM issued_tokens token
  WHERE token.status = 'pending'
    AND token.mint_address IS NULL
    AND token.signing_custody_wallet_id IS NOT NULL
)
SELECT id, organization_id, project_id, signing_custody_wallet_id,
       signing_wallet_id, legacy_custody_wallet_id
FROM resolutions
WHERE legacy_custody_wallet_id IS DISTINCT FROM signing_custody_wallet_id
ORDER BY organization_id, project_id, id
LIMIT 100;

\echo '=== 3. Unfinished Issuance transactions (must be zero before cutover or rollback) ==='
SELECT id, token_id, organization_id, custody_wallet_id, type, status, created_at
FROM issuance_transactions
WHERE status IN ('pending', 'processing')
ORDER BY organization_id, id
LIMIT 100;

\echo '=== 4. Issuance transaction exact-ID tenant disagreements (must be zero) ==='
WITH wallet_scope AS (
  SELECT wallet.id,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
)
SELECT transaction.id, transaction.token_id, transaction.organization_id,
       token.organization_id AS token_organization_id, token.project_id,
       transaction.custody_wallet_id
FROM issuance_transactions transaction
JOIN issued_tokens token ON token.id = transaction.token_id
WHERE transaction.custody_wallet_id IS NOT NULL
  AND (
    transaction.organization_id IS DISTINCT FROM token.organization_id
    OR NOT EXISTS (
      SELECT 1
      FROM wallet_scope wallet
      WHERE wallet.id = transaction.custody_wallet_id
        AND wallet.organization_id = token.organization_id
        AND ((wallet.owner_kind = 'config'
              AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL))
          OR (wallet.owner_kind = 'connection' AND wallet.project_id = token.project_id))
    )
  )
ORDER BY transaction.organization_id, transaction.id
LIMIT 100;

\echo '=== 5. Transitional Issuance deploy claims (must be zero before rollback) ==='
SELECT id, organization_id, project_id, signing_custody_wallet_id, updated_at
FROM issued_tokens
WHERE status = 'deploying'
ORDER BY organization_id, project_id, id;

\echo '=== 6. Unfinished Issuance approvals (must be zero before rollback) ==='
SELECT id, organization_id, project_id, operation_type, status,
       custody_wallet_id, created_at
FROM wallet_operations
WHERE operation_type IN ('issuance_mint_execute', 'issuance_update_authority_execute')
  AND status IN ('pending_approval', 'executing')
ORDER BY organization_id, id;

\echo '=== 7. Terminal legacy Issuance transaction history without an exact ID (informational) ==='
SELECT id, token_id, organization_id, type, status, created_at
FROM issuance_transactions
WHERE custody_wallet_id IS NULL
  AND status IN ('confirmed', 'finalized', 'failed')
ORDER BY organization_id, id
LIMIT 100;
