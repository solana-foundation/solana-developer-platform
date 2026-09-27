-- SOLA9-596 / APE-794: migration 0073 backfilled the recurring-payment parent
-- pin but not in-flight source-changing replacement attempts written by the
-- predecessor. Those rows carry the legacy `sourceWalletId` snapshot
-- vocabulary (wallet_id values) and a NULL `new_source_custody_wallet_id`, so
-- update recovery permanently rejects the exact replacement wallet. Backfill
-- resolvable rows from the legacy snapshots using tenant-scoped wallet
-- resolution, then from the replacement plan owner (wallet_id plus public
-- key) for recorded work the wallet_id alone cannot resolve, normalize the
-- legacy `sourceWalletId` snapshot vocabulary to `sourceCustodyWalletId`
-- (custody ids, before value from the parent pin), and quarantine ambiguous
-- or incomplete rows that have recorded no replacement side effects;
-- side-effected rows stay in flight so the recovery path resumes them
-- instead of restarting completed work.

CREATE TEMP VIEW recurring_attempt_wallet_scope AS
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

-- Attempts the wallet_id snapshot alone could not resolve but that already
-- created their replacement plan: the plan owner records the exact custody
-- wallet the original attempt selected (wallet_id plus public key, the same
-- identity pair migration 0073 pins parents by). Resolve those identities so
-- recorded replacement work stays recoverable instead of stuck behind a
-- retry that can never prove which custody wallet to pin.
WITH legacy_attempts AS (
    SELECT attempt.id AS attempt_id,
           attempt.organization_id,
           attempt.project_id,
           attempt.recurring_payment_id,
           attempt.after_values ->> 'sourceWalletId' AS new_wallet_id,
           plan.owner_address AS new_public_key
    FROM payment_recurring_payment_update_attempts attempt
    JOIN payment_subscription_plans plan ON plan.id = attempt.new_plan_id
    WHERE attempt.status = 'processing'
      AND attempt.new_source_custody_wallet_id IS NULL
      AND attempt.changed_fields @> ARRAY['sourceWalletId']::text[]
      AND attempt.after_values ? 'sourceWalletId'
      AND plan.owner_wallet_id = attempt.after_values ->> 'sourceWalletId'
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
     AND wallet.public_key = legacy.new_public_key
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

-- Whatever the backfill could not resolve exactly is ambiguous or incomplete.
-- Attempts with no recorded side effects are quarantined out of the in-flight
-- set into an explicit repairable state instead of guessing an identity: a
-- retry then creates a fresh attempt with exact custody-wallet pinning.
-- Attempts that already recorded replacement work (created plan, authorized
-- subscription, canceled the old one) keep processing status so recovery
-- resumes them where they stopped instead of repeating replacement
-- operations — re-running an already-successful old-subscription cancellation
-- would block finalizing the authorized replacement. When a later retry
-- cannot prove the recorded identity against any custody wallet, the
-- recovery path journals the attempt failed with its recorded work intact
-- and releases the parent, unless the old subscription was already canceled
-- on-chain — that case stays in flight for manual reconciliation because a
-- fresh start would repeat the cancellation.
UPDATE payment_recurring_payment_update_attempts attempt
SET status = 'failed',
    error = 'legacy source-changing replacement attempt could not be resolved to an exact custody wallet; retry the update to create a fresh attempt'
WHERE attempt.status = 'processing'
  AND attempt.new_source_custody_wallet_id IS NULL
  AND attempt.changed_fields @> ARRAY['sourceWalletId']::text[]
  AND attempt.new_plan_id IS NULL
  AND attempt.new_subscription_id IS NULL
  AND attempt.plan_update_signature IS NULL
  AND attempt.plan_creation_signature IS NULL
  AND attempt.authorization_setup_signature IS NULL
  AND attempt.authorization_signature IS NULL
  AND attempt.old_cancel_signature IS NULL;

DROP VIEW recurring_attempt_wallet_scope;
