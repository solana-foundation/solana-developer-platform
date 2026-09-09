\set ON_ERROR_STOP on

-- Idempotent catch-up for rows created by old instances during deployment.
-- Run after old recurring HTTP and cron work has drained, then run the audit.

\echo '=== Recurring Payment exact identity before catch-up ==='
SELECT COUNT(*) AS recurring_payments_without_exact_wallet
FROM payment_recurring_payments
WHERE source_custody_wallet_id IS NULL;

BEGIN;

CREATE TEMP VIEW recurring_wallet_scope AS
SELECT
    wallet.id,
    wallet.wallet_id,
    wallet.public_key,
    config.organization_id,
    config.project_id,
    'config'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_configs config ON config.id = wallet.custody_config_id
UNION ALL
SELECT
    wallet.id,
    wallet.wallet_id,
    wallet.public_key,
    connection.organization_id,
    connection.project_id,
    'connection'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_connections connection ON connection.id = wallet.custody_connection_id;

WITH unique_matches AS (
    SELECT recurring.id AS recurring_payment_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_recurring_payments recurring
    JOIN recurring_wallet_scope wallet
      ON wallet.organization_id = recurring.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = recurring.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = recurring.project_id)
     )
     AND wallet.wallet_id = recurring.source_wallet_id
     AND wallet.public_key = recurring.source_address
    WHERE recurring.source_custody_wallet_id IS NULL
    GROUP BY recurring.id
    HAVING COUNT(*) = 1
)
UPDATE payment_recurring_payments recurring
SET source_custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE recurring.id = unique_matches.recurring_payment_id
  AND recurring.source_custody_wallet_id IS NULL;

DROP VIEW recurring_wallet_scope;

COMMIT;

\echo '=== Recurring Payment exact identity after catch-up ==='
SELECT COUNT(*) AS recurring_payments_without_exact_wallet
FROM payment_recurring_payments
WHERE source_custody_wallet_id IS NULL;
