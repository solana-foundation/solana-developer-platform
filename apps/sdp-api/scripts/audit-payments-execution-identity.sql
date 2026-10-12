\set ON_ERROR_STOP on

-- Read-only Payments release audit. Run before the initial backfill and
-- again after backfill-payments-execution-identity.sql. Retained wallet history
-- participates in matching; status is intentionally not filtered.

\echo '=== 1. Null Payments identities by exactly-one resolution ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         config.organization_id, config.project_id
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         connection.organization_id, connection.project_id
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), resolutions AS (
  SELECT 'transfer'::TEXT AS resource, transfer.id, transfer.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = transfer.organization_id
            AND wallet.project_id = transfer.project_id
            AND wallet.wallet_id = transfer.wallet_id
            AND wallet.public_key = CASE WHEN transfer.direction = 'inbound'
                                         THEN transfer.destination_address
                                         ELSE transfer.source_address END) AS match_count
  FROM payment_transfers transfer
  WHERE transfer.custody_wallet_id IS NULL
  UNION ALL
  SELECT 'batch', batch.id, batch.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = batch.organization_id
            AND wallet.project_id = batch.project_id
            AND wallet.wallet_id = batch.source_wallet_id
            AND wallet.public_key = batch.source_address)
  FROM payment_transfer_batches batch
  WHERE batch.source_custody_wallet_id IS NULL
  UNION ALL
  SELECT 'payment_request', request.id, request.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = request.organization_id
            AND wallet.project_id = request.project_id
            AND wallet.wallet_id = request.wallet_id
            AND wallet.public_key = request.destination_address)
  FROM payment_requests request
  WHERE request.custody_wallet_id IS NULL
)
SELECT resource, status,
       COUNT(*) FILTER (WHERE match_count = 1) AS resolvable_unique,
       COUNT(*) FILTER (WHERE match_count = 0) AS unresolved_zero,
       COUNT(*) FILTER (WHERE match_count > 1) AS ambiguous_multi
FROM resolutions
GROUP BY resource, status
ORDER BY resource, status;

\echo '=== 1a. Unresolved or ambiguous Payments rows (up to 100) ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         config.organization_id, config.project_id
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         connection.organization_id, connection.project_id
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), resolutions AS (
  SELECT 'transfer'::TEXT AS resource, transfer.id, transfer.organization_id,
         transfer.project_id, transfer.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = transfer.organization_id
            AND wallet.project_id = transfer.project_id
            AND wallet.wallet_id = transfer.wallet_id
            AND wallet.public_key = CASE WHEN transfer.direction = 'inbound'
                                         THEN transfer.destination_address
                                         ELSE transfer.source_address END) AS match_count
  FROM payment_transfers transfer WHERE transfer.custody_wallet_id IS NULL
  UNION ALL
  SELECT 'batch', batch.id, batch.organization_id, batch.project_id, batch.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = batch.organization_id
            AND wallet.project_id = batch.project_id
            AND wallet.wallet_id = batch.source_wallet_id
            AND wallet.public_key = batch.source_address)
  FROM payment_transfer_batches batch WHERE batch.source_custody_wallet_id IS NULL
  UNION ALL
  SELECT 'payment_request', request.id, request.organization_id, request.project_id, request.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = request.organization_id
            AND wallet.project_id = request.project_id
            AND wallet.wallet_id = request.wallet_id
            AND wallet.public_key = request.destination_address)
  FROM payment_requests request WHERE request.custody_wallet_id IS NULL
)
SELECT resource, id, organization_id, project_id, status, match_count
FROM resolutions
WHERE match_count <> 1
ORDER BY resource, organization_id, id
LIMIT 100;

\echo '=== 2. Persisted exact IDs that disagree with retained evidence (must be zero) ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         config.organization_id, config.project_id
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         connection.organization_id, connection.project_id
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), mismatches AS (
  SELECT 'transfer'::TEXT AS resource, transfer.id, transfer.custody_wallet_id
  FROM payment_transfers transfer
  WHERE transfer.custody_wallet_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM wallet_scope wallet
      WHERE wallet.id = transfer.custody_wallet_id
        AND wallet.organization_id = transfer.organization_id
        AND wallet.project_id = transfer.project_id
        AND wallet.wallet_id = transfer.wallet_id
        AND wallet.public_key = CASE WHEN transfer.direction = 'inbound'
                                     THEN transfer.destination_address
                                     ELSE transfer.source_address END
    )
  UNION ALL
  SELECT 'batch', batch.id, batch.source_custody_wallet_id
  FROM payment_transfer_batches batch
  WHERE batch.source_custody_wallet_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM wallet_scope wallet
      WHERE wallet.id = batch.source_custody_wallet_id
        AND wallet.organization_id = batch.organization_id
        AND wallet.project_id = batch.project_id
        AND wallet.wallet_id = batch.source_wallet_id
        AND wallet.public_key = batch.source_address
    )
  UNION ALL
  SELECT 'payment_request', request.id, request.custody_wallet_id
  FROM payment_requests request
  WHERE request.custody_wallet_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM wallet_scope wallet
      WHERE wallet.id = request.custody_wallet_id
        AND wallet.organization_id = request.organization_id
        AND wallet.project_id = request.project_id
        AND wallet.wallet_id = request.wallet_id
        AND wallet.public_key = request.destination_address
    )
)
SELECT * FROM mismatches ORDER BY resource, id LIMIT 100;

\echo '=== 2a. Batch/chunk exact-ID disagreements (must be zero) ==='
SELECT DISTINCT
       batch.id AS batch_id,
       transfer.id AS transfer_id,
       batch.organization_id,
       batch.project_id,
       batch.source_custody_wallet_id AS batch_custody_wallet_id,
       transfer.custody_wallet_id AS transfer_custody_wallet_id,
       batch.status AS batch_status, transfer.status AS transfer_status,
       transfer.signature, transfer.signed_transaction IS NOT NULL AS has_signed_transaction,
       transfer.submission_started_at
FROM payment_transfer_batches batch
JOIN payment_transfer_recipients recipient
  ON recipient.batch_id = batch.id
 AND recipient.organization_id = batch.organization_id
 AND recipient.project_id = batch.project_id
JOIN payment_transfers transfer
  ON transfer.id = recipient.transfer_id
 AND transfer.organization_id = recipient.organization_id
 AND transfer.project_id = recipient.project_id
WHERE batch.source_custody_wallet_id IS DISTINCT FROM transfer.custody_wallet_id
ORDER BY batch.organization_id, batch.id, transfer.id
LIMIT 100;

\echo '=== 2b. Unresolved nonterminal Payment Requests (review before cutover) ==='
SELECT id, organization_id, project_id, status
FROM payment_requests
WHERE status = 'awaiting_payment'
  AND custody_wallet_id IS NULL
ORDER BY organization_id, id
LIMIT 100;

\echo '=== 3. Unresolved executable transfers, batches and ramps (review before cutover) ==='
SELECT CASE WHEN transfer.type IN ('onramp', 'offramp') THEN 'ramp' ELSE 'transfer' END AS resource,
       transfer.id, transfer.organization_id, transfer.project_id, transfer.status
FROM payment_transfers transfer
WHERE transfer.custody_wallet_id IS NULL
  AND (transfer.type IN ('transfer', 'transfer_batch')
       AND transfer.status IN ('pending', 'processing', 'confirmed')
    OR transfer.type IN ('onramp', 'offramp')
       AND transfer.status IN ('pending', 'processing', 'confirmed', 'finalized', 'awaiting_payment', 'settling'))
UNION ALL
SELECT 'batch', batch.id, batch.organization_id, batch.project_id, batch.status
FROM payment_transfer_batches batch
WHERE batch.source_custody_wallet_id IS NULL
  AND (batch.status = 'processing' OR EXISTS (
    SELECT 1 FROM payment_transfer_recipients recipient
    LEFT JOIN payment_transfers transfer
      ON transfer.id = recipient.transfer_id
     AND transfer.organization_id = recipient.organization_id
     AND transfer.project_id = recipient.project_id
    WHERE recipient.batch_id = batch.id
      AND recipient.organization_id = batch.organization_id
      AND recipient.project_id = batch.project_id
      AND (recipient.status IN ('pending', 'processing')
        OR transfer.status IN ('pending', 'processing', 'confirmed')
        OR transfer.status NOT IN ('finalized', 'completed')
           AND (transfer.signature IS NOT NULL OR transfer.signed_transaction IS NOT NULL
             OR transfer.submission_started_at IS NOT NULL))
  ))
ORDER BY resource, organization_id, id;

\echo '=== 4. Retained unfinished submission and ramp effects (reconcile before cutover) ==='
-- Parent status alone does not establish that an external effect is absent.
SELECT id, organization_id, project_id, type, status, custody_wallet_id,
       signature, signed_transaction IS NOT NULL AS has_signed_transaction,
       last_valid_block_height, submission_started_at, provider, provider_reference,
       provider_data #>> '{moneygram,cryptoTransferId}' AS crypto_transfer_id
FROM payment_transfers
WHERE (type IN ('transfer', 'transfer_batch') AND status <> 'finalized'
    OR type IN ('onramp', 'offramp') AND status <> 'completed')
  AND (signature IS NOT NULL OR signed_transaction IS NOT NULL OR submission_started_at IS NOT NULL
    OR provider_data #>> '{moneygram,cryptoTransferId}' IS NOT NULL
    OR type IN ('onramp', 'offramp') AND provider_reference IS NOT NULL
       AND status IN ('pending', 'processing', 'confirmed', 'finalized', 'awaiting_payment', 'settling'))
ORDER BY organization_id, id;

\echo '=== 5. MoneyGram ramp/crypto-leg exact-ID disagreements (review before cutover) ==='
SELECT ramp.id AS ramp_id, ramp.organization_id, ramp.project_id,
       ramp.custody_wallet_id AS ramp_custody_wallet_id,
       ramp.provider_reference, ramp.status AS ramp_status,
       ramp.provider_data #>> '{moneygram,cryptoTransferId}' AS crypto_transfer_id,
       leg.custody_wallet_id AS crypto_custody_wallet_id, leg.status AS crypto_status,
       leg.signature, leg.submission_started_at
FROM payment_transfers ramp
LEFT JOIN payment_transfers leg
  ON leg.id = ramp.provider_data #>> '{moneygram,cryptoTransferId}'
 AND leg.organization_id = ramp.organization_id
 AND leg.project_id = ramp.project_id
WHERE ramp.type = 'offramp' AND ramp.provider = 'moneygram'
  AND ramp.provider_data #>> '{moneygram,cryptoTransferId}' IS NOT NULL
  AND (ramp.custody_wallet_id IS NULL OR leg.custody_wallet_id IS NULL
    OR ramp.custody_wallet_id IS DISTINCT FROM leg.custody_wallet_id)
ORDER BY ramp.organization_id, ramp.id;
