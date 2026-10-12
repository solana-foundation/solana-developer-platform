\set ON_ERROR_STOP on

-- Idempotent HOO-1023 K3 catch-up. Run after old HTTP/cron executions and
-- leases have drained, then run audit-payments-execution-identity.sql.

\echo '=== Payments exact identity before catch-up ==='
SELECT
  (SELECT COUNT(*) FROM payment_transfers WHERE custody_wallet_id IS NULL)
    AS transfers_without_exact_wallet,
  (SELECT COUNT(*) FROM payment_transfer_batches WHERE source_custody_wallet_id IS NULL)
    AS batches_without_exact_wallet,
  (SELECT COUNT(*) FROM payment_requests WHERE custody_wallet_id IS NULL)
    AS requests_without_exact_wallet;

BEGIN;

CREATE TEMP VIEW k3_payments_wallet_scope AS
SELECT
    wallet.id,
    wallet.wallet_id,
    wallet.public_key,
    config.organization_id,
    config.project_id
FROM custody_wallets wallet
JOIN custody_configs config ON config.id = wallet.custody_config_id
UNION ALL
SELECT
    wallet.id,
    wallet.wallet_id,
    wallet.public_key,
    connection.organization_id,
    connection.project_id
FROM custody_wallets wallet
JOIN custody_connections connection ON connection.id = wallet.custody_connection_id;

WITH unique_matches AS (
    SELECT transfer.id AS transfer_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_transfers transfer
    JOIN k3_payments_wallet_scope wallet
      ON wallet.organization_id = transfer.organization_id
     AND wallet.project_id = transfer.project_id
     AND wallet.wallet_id = transfer.wallet_id
     AND wallet.public_key = CASE
          WHEN transfer.direction = 'inbound' THEN transfer.destination_address
          ELSE transfer.source_address
     END
    WHERE transfer.custody_wallet_id IS NULL
    GROUP BY transfer.id
    HAVING COUNT(*) = 1
)
UPDATE payment_transfers transfer
SET custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE transfer.id = unique_matches.transfer_id
  AND transfer.custody_wallet_id IS NULL;

WITH unique_matches AS (
    SELECT batch.id AS batch_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_transfer_batches batch
    JOIN k3_payments_wallet_scope wallet
      ON wallet.organization_id = batch.organization_id
     AND wallet.project_id = batch.project_id
     AND wallet.wallet_id = batch.source_wallet_id
     AND wallet.public_key = batch.source_address
    WHERE batch.source_custody_wallet_id IS NULL
    GROUP BY batch.id
    HAVING COUNT(*) = 1
)
UPDATE payment_transfer_batches batch
SET source_custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE batch.id = unique_matches.batch_id
  AND batch.source_custody_wallet_id IS NULL;

WITH unique_matches AS (
    SELECT request.id AS request_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_requests request
    JOIN k3_payments_wallet_scope wallet
      ON wallet.organization_id = request.organization_id
     AND wallet.project_id = request.project_id
     AND wallet.wallet_id = request.wallet_id
     AND wallet.public_key = request.destination_address
    WHERE request.custody_wallet_id IS NULL
    GROUP BY request.id
    HAVING COUNT(*) = 1
)
UPDATE payment_requests request
SET custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE request.id = unique_matches.request_id
  AND request.custody_wallet_id IS NULL;

DROP VIEW k3_payments_wallet_scope;

COMMIT;

\echo '=== Payments exact identity after catch-up ==='
SELECT
  (SELECT COUNT(*) FROM payment_transfers WHERE custody_wallet_id IS NULL)
    AS transfers_without_exact_wallet,
  (SELECT COUNT(*) FROM payment_transfer_batches WHERE source_custody_wallet_id IS NULL)
    AS batches_without_exact_wallet,
  (SELECT COUNT(*) FROM payment_requests WHERE custody_wallet_id IS NULL)
    AS requests_without_exact_wallet;

-- BEGIN recurring exact identity
-- Repeat after incompatible writers retire. Retained inactive/archived wallets
-- count as evidence; catch-up never makes them operational or replaces a pin.
BEGIN;

CREATE TEMP VIEW recurring_catchup_wallet_scope AS
SELECT wallet.id, wallet.wallet_id, wallet.public_key,
       config.organization_id, config.project_id
FROM custody_wallets wallet
JOIN custody_configs config ON config.id = wallet.custody_config_id
UNION ALL
SELECT wallet.id, wallet.wallet_id, wallet.public_key,
       connection.organization_id, connection.project_id
FROM custody_wallets wallet
JOIN custody_connections connection ON connection.id = wallet.custody_connection_id;

WITH matches AS (
  SELECT plan.id, plan.organization_id, plan.project_id, plan.owner_wallet_id, plan.owner_address,
         MIN(wallet.id) AS custody_wallet_id
  FROM payment_subscription_plans plan
  JOIN recurring_catchup_wallet_scope wallet
    ON wallet.organization_id = plan.organization_id
   AND wallet.project_id = plan.project_id
   AND wallet.wallet_id = plan.owner_wallet_id
   AND wallet.public_key = plan.owner_address
  WHERE plan.owner_custody_wallet_id IS NULL
    AND (plan.role_projection_revision > 0 OR plan.puller_custody_wallet_id IS NULL)
  GROUP BY plan.id, plan.organization_id, plan.project_id, plan.owner_wallet_id, plan.owner_address
  HAVING COUNT(*) = 1
)
UPDATE payment_subscription_plans plan
SET owner_custody_wallet_id = matches.custody_wallet_id,
    role_projection_revision = plan.role_projection_revision + 1
FROM matches
WHERE plan.id = matches.id
  AND plan.organization_id = matches.organization_id
  AND plan.project_id = matches.project_id
  AND plan.owner_custody_wallet_id IS NULL
  AND (plan.role_projection_revision > 0 OR plan.puller_custody_wallet_id IS NULL)
  AND plan.owner_wallet_id = matches.owner_wallet_id
  AND plan.owner_address = matches.owner_address;

WITH matches AS (
  SELECT plan.id, plan.organization_id, plan.project_id, plan.puller_wallet_id, plan.puller_address,
         MIN(wallet.id) AS custody_wallet_id
  FROM payment_subscription_plans plan
  JOIN recurring_catchup_wallet_scope wallet
    ON wallet.organization_id = plan.organization_id
   AND wallet.project_id = plan.project_id
   AND wallet.wallet_id = plan.puller_wallet_id
   AND wallet.public_key = plan.puller_address
  WHERE plan.puller_custody_wallet_id IS NULL
    AND (plan.role_projection_revision > 0 OR plan.owner_custody_wallet_id IS NULL)
  GROUP BY plan.id, plan.organization_id, plan.project_id, plan.puller_wallet_id, plan.puller_address
  HAVING COUNT(*) = 1
)
UPDATE payment_subscription_plans plan
SET puller_custody_wallet_id = matches.custody_wallet_id,
    role_projection_revision = plan.role_projection_revision + 1
FROM matches
WHERE plan.id = matches.id
  AND plan.organization_id = matches.organization_id
  AND plan.project_id = matches.project_id
  AND plan.puller_custody_wallet_id IS NULL
  AND (plan.role_projection_revision > 0 OR plan.owner_custody_wallet_id IS NULL)
  AND plan.puller_wallet_id = matches.puller_wallet_id
  AND plan.puller_address = matches.puller_address;

WITH matches AS (
  SELECT recurring.id, recurring.organization_id, recurring.project_id, recurring.source_wallet_id, recurring.source_address,
         MIN(wallet.id) AS custody_wallet_id
  FROM payment_recurring_payments recurring
  JOIN recurring_catchup_wallet_scope wallet
    ON wallet.organization_id = recurring.organization_id
   AND wallet.project_id = recurring.project_id
   AND wallet.wallet_id = recurring.source_wallet_id
   AND wallet.public_key = recurring.source_address
  WHERE recurring.source_custody_wallet_id IS NULL
  GROUP BY recurring.id, recurring.organization_id, recurring.project_id, recurring.source_wallet_id, recurring.source_address
  HAVING COUNT(*) = 1
)
UPDATE payment_recurring_payments recurring
SET source_custody_wallet_id = matches.custody_wallet_id
FROM matches
WHERE recurring.id = matches.id
  AND recurring.organization_id = matches.organization_id
  AND recurring.project_id = matches.project_id
  AND recurring.source_custody_wallet_id IS NULL
  AND recurring.source_wallet_id = matches.source_wallet_id
  AND recurring.source_address = matches.source_address;

-- A replacement's new source belongs to its saved new plan, never today's parent.
WITH matches AS (
  SELECT attempt.id, attempt.organization_id, attempt.project_id, attempt.new_plan_id, attempt.after_values,
         MIN(wallet.id) AS custody_wallet_id
  FROM payment_recurring_payment_update_attempts attempt
  JOIN payment_subscription_plans plan
    ON plan.id = attempt.new_plan_id
   AND plan.organization_id = attempt.organization_id
   AND plan.project_id = attempt.project_id
  JOIN recurring_catchup_wallet_scope wallet
    ON wallet.organization_id = plan.organization_id
   AND wallet.project_id = plan.project_id
   AND wallet.wallet_id = plan.owner_wallet_id
   AND wallet.public_key = plan.owner_address
   AND (plan.owner_custody_wallet_id IS NULL OR plan.owner_custody_wallet_id = wallet.id)
  WHERE attempt.mode = 'replacement'
    AND attempt.new_source_custody_wallet_id IS NULL
    AND (attempt.after_values ->> 'sourceCustodyWalletId' IS NULL
         OR attempt.after_values ->> 'sourceCustodyWalletId' = wallet.id)
  GROUP BY attempt.id, attempt.organization_id, attempt.project_id, attempt.new_plan_id, attempt.after_values
  HAVING COUNT(*) = 1
)
UPDATE payment_recurring_payment_update_attempts attempt
SET new_source_custody_wallet_id = matches.custody_wallet_id
FROM matches
WHERE attempt.id = matches.id
  AND attempt.organization_id = matches.organization_id
  AND attempt.project_id = matches.project_id
  AND attempt.mode = 'replacement'
  AND attempt.new_source_custody_wallet_id IS NULL
  AND attempt.new_plan_id = matches.new_plan_id
  AND attempt.after_values = matches.after_values;

DROP VIEW recurring_catchup_wallet_scope;
COMMIT;
-- END recurring exact identity
