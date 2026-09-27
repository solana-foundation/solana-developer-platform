-- SOLA9-596 / APE-794: migration 0073 backfilled the recurring-payment parent
-- pin but not in-flight source-changing replacement attempts written by the
-- predecessor. Those rows carry the legacy `sourceWalletId` snapshot
-- vocabulary (wallet_id values) and a NULL `new_source_custody_wallet_id`, so
-- update recovery permanently rejects the exact replacement wallet. Backfill
-- resolvable rows from the legacy snapshots using tenant-scoped wallet
-- resolution, normalize their snapshots to the current vocabulary, and
-- quarantine ambiguous or incomplete rows instead of guessing.

CREATE TEMP VIEW recurring_attempt_wallet_scope AS
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

WITH legacy_attempts AS (
    SELECT attempt.id AS attempt_id,
           attempt.organization_id,
           attempt.project_id,
           attempt.recurring_payment_id,
           attempt.after_values ->> 'sourceWalletId' AS new_wallet_id
    FROM payment_recurring_payment_update_attempts attempt
    WHERE attempt.status = 'processing'
      AND attempt.new_source_custody_wallet_id IS NULL
      AND attempt.changed_fields @> ARRAY['sourceWalletId']::text[]
      AND attempt.after_values ? 'sourceWalletId'
),
unique_matches AS (
    SELECT legacy.attempt_id, MIN(wallet.id) AS custody_wallet_id
    FROM legacy_attempts legacy
    JOIN recurring_attempt_wallet_scope wallet
      ON wallet.organization_id = legacy.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = legacy.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = legacy.project_id)
     )
     AND wallet.wallet_id = legacy.new_wallet_id
    GROUP BY legacy.attempt_id
    HAVING COUNT(*) = 1
)
UPDATE payment_recurring_payment_update_attempts attempt
SET new_source_custody_wallet_id = unique_matches.custody_wallet_id,
    changed_fields = array_replace(attempt.changed_fields, 'sourceWalletId', 'sourceCustodyWalletId'),
    before_values = (attempt.before_values - 'sourceWalletId')
                    || jsonb_build_object('sourceCustodyWalletId', recurring.source_custody_wallet_id),
    after_values = (attempt.after_values - 'sourceWalletId')
                   || jsonb_build_object('sourceCustodyWalletId', unique_matches.custody_wallet_id)
FROM legacy_attempts legacy
JOIN unique_matches ON unique_matches.attempt_id = legacy.attempt_id
JOIN payment_recurring_payments recurring ON recurring.id = legacy.recurring_payment_id
WHERE attempt.id = legacy.attempt_id
  AND recurring.source_custody_wallet_id IS NOT NULL;

-- Legacy in-flight attempts that only rename the snapshot key (no source
-- change) normalize against the parent pin; a NULL parent pin matches the
-- NULL the recovery comparison reads from the parent row.
UPDATE payment_recurring_payment_update_attempts attempt
SET before_values = (attempt.before_values - 'sourceWalletId')
                    || jsonb_build_object('sourceCustodyWalletId', recurring.source_custody_wallet_id),
    after_values = (attempt.after_values - 'sourceWalletId')
                   || jsonb_build_object('sourceCustodyWalletId', recurring.source_custody_wallet_id)
FROM payment_recurring_payments recurring
WHERE attempt.recurring_payment_id = recurring.id
  AND attempt.status = 'processing'
  AND attempt.new_source_custody_wallet_id IS NULL
  AND NOT attempt.changed_fields @> ARRAY['sourceWalletId']::text[]
  AND (attempt.before_values ? 'sourceWalletId' OR attempt.after_values ? 'sourceWalletId');

-- Whatever the backfill could not resolve exactly is ambiguous or incomplete:
-- quarantine it out of the in-flight set into an explicit repairable state
-- instead of guessing an identity. A retry then creates a fresh attempt with
-- exact custody-wallet pinning.
UPDATE payment_recurring_payment_update_attempts attempt
SET status = 'failed',
    error = 'legacy source-changing replacement attempt could not be resolved to an exact custody wallet; retry the update to create a fresh attempt'
WHERE attempt.status = 'processing'
  AND attempt.new_source_custody_wallet_id IS NULL
  AND attempt.changed_fields @> ARRAY['sourceWalletId']::text[];

DROP VIEW recurring_attempt_wallet_scope;
