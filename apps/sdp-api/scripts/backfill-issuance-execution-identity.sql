\set ON_ERROR_STOP on

-- Idempotent catch-up for drafts created by old instances during deployment.
-- Run after old Issuance writers drain, then run the audit. Never infer a
-- deployed token's signer or any historical transaction signer.

\echo '=== Issuance exact identity before catch-up ==='
SELECT COUNT(*) AS pending_drafts_without_exact_wallet
FROM issued_tokens
WHERE status = 'pending'
  AND mint_address IS NULL
  AND signing_wallet_id IS NOT NULL
  AND signing_custody_wallet_id IS NULL;

BEGIN;

CREATE TEMP VIEW issuance_catch_up_wallet_scope AS
SELECT
    wallet.id,
    wallet.wallet_id,
    config.organization_id,
    config.project_id,
    'config'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_configs config ON config.id = wallet.custody_config_id
UNION ALL
SELECT
    wallet.id,
    wallet.wallet_id,
    connection.organization_id,
    connection.project_id,
    'connection'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_connections connection ON connection.id = wallet.custody_connection_id;

WITH unique_matches AS (
    SELECT token.id AS token_id, MIN(wallet.id) AS custody_wallet_id
    FROM issued_tokens token
    JOIN issuance_catch_up_wallet_scope wallet
      ON wallet.organization_id = token.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = token.project_id)
     )
     AND wallet.wallet_id = token.signing_wallet_id
    WHERE token.status = 'pending'
      AND token.mint_address IS NULL
      AND token.signing_wallet_id IS NOT NULL
      AND token.signing_custody_wallet_id IS NULL
    GROUP BY token.id
    HAVING COUNT(*) = 1
)
UPDATE issued_tokens token
SET signing_custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE token.id = unique_matches.token_id
  AND token.status = 'pending'
  AND token.mint_address IS NULL
  AND token.signing_custody_wallet_id IS NULL;

DROP VIEW issuance_catch_up_wallet_scope;

COMMIT;

\echo '=== Issuance exact identity after catch-up ==='
SELECT COUNT(*) AS pending_drafts_without_exact_wallet
FROM issued_tokens
WHERE status = 'pending'
  AND mint_address IS NULL
  AND signing_wallet_id IS NOT NULL
  AND signing_custody_wallet_id IS NULL;
