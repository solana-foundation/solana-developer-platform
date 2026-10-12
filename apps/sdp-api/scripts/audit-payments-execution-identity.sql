\set ON_ERROR_STOP on

-- Read-only HOO-1023 K3 release audit. Run before the initial backfill and
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
       transfer.custody_wallet_id AS transfer_custody_wallet_id
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

\echo '=== 2b. Unresolved payable Payment Requests (review before cutover) ==='
SELECT request.id, request.organization_id, request.project_id, request.status, request.expires_at
FROM payment_requests request
JOIN projects project
  ON project.id = request.project_id AND project.organization_id = request.organization_id
JOIN organizations organization ON organization.id = request.organization_id
WHERE request.status = 'awaiting_payment'
  AND request.custody_wallet_id IS NULL
  AND (request.expires_at IS NULL OR request.expires_at::TIMESTAMPTZ > NOW())
  AND project.status = 'active'
  AND organization.status = 'active'
  AND CASE WHEN project.environment = 'production'
           THEN COALESCE(organization.settings::JSONB -> 'enableProductionProject' = 'true'::JSONB, FALSE)
           ELSE TRUE END
ORDER BY request.organization_id, request.id
LIMIT 100;

\echo '=== 2c. All retained Request claims (parent lifecycle never releases exposure) ==='
-- SQL cannot establish blockhash expiry or prove message/accounting ownership.
-- Keep terminal and expired parents for the continuity reader; omit bearer bytes.
SELECT request.id, request.organization_id, request.project_id,
       request.status AS request_status, request.expires_at,
       request.custody_wallet_id, request.sponsored_tx_account,
       request.sponsored_tx_last_valid_block_height,
       request.sponsored_tx_signed IS NOT NULL AS has_signed_claim,
       request.sponsored_tx_continuity ->> 'deploymentMode' AS deployment_mode,
       request.sponsored_tx_continuity #>> '{accountingIdentity,reservationId}' AS reservation_id,
       CASE
         WHEN request.sponsored_tx_account IS NULL
           OR request.sponsored_tx_unsigned IS NULL
           OR request.sponsored_tx_last_valid_block_height IS NULL
           THEN 'invalid_claim_shape'
         WHEN request.sponsored_tx_continuity IS NOT NULL AND (
           jsonb_typeof(request.sponsored_tx_continuity) IS DISTINCT FROM 'object'
           OR NOT COALESCE(request.sponsored_tx_continuity ->> 'deploymentMode' IN ('managed', 'self_hosted'), FALSE)
           OR (request.sponsored_tx_continuity ->> 'deploymentMode' = 'self_hosted'
               AND request.sponsored_tx_continuity -> 'accountingIdentity' IS DISTINCT FROM 'null'::JSONB)
         ) THEN 'invalid_continuity_shape'
         WHEN request.sponsored_tx_continuity IS NOT NULL AND (
           request.sponsored_tx_continuity ->> 'account' IS DISTINCT FROM request.sponsored_tx_account
           OR request.sponsored_tx_continuity ->> 'unsignedTransaction' IS DISTINCT FROM request.sponsored_tx_unsigned
           OR request.sponsored_tx_continuity ->> 'lastValidBlockHeight' IS DISTINCT FROM request.sponsored_tx_last_valid_block_height::TEXT
         ) THEN 'stale_continuity_projection'
         WHEN request.sponsored_tx_signed IS NOT NULL THEN 'signed_claim_review'
         ELSE 'unsigned_claim_review'
       END AS classification
FROM payment_requests request
WHERE request.sponsored_tx_account IS NOT NULL
   OR request.sponsored_tx_unsigned IS NOT NULL
   OR request.sponsored_tx_signed IS NOT NULL
   OR request.sponsored_tx_last_valid_block_height IS NOT NULL
   OR request.sponsored_tx_continuity IS NOT NULL
ORDER BY request.organization_id, request.id;

\echo '=== 2d. Outstanding sponsorship accounting (Request ownership requires message proof) ==='
-- Replaced windows may no longer have a current Request projection. A shared
-- wallet actor never proves ownership; the Foundation continuity reader does.
SELECT reservation.id, reservation.organization_id, reservation.project_id,
       reservation.network, reservation.product_environment,
       reservation.actor_type, reservation.actor_id, reservation.status,
       reservation.attempt, reservation.reserved_lamports, reservation.actual_lamports,
       reservation.signature, reservation.signed_transaction IS NOT NULL AS has_signed_transaction,
       reservation.transaction_digest, reservation.provider_config_fingerprint,
       reservation.redis_settled_at, reservation.created_at, reservation.updated_at,
       CASE
         WHEN reservation.status = 'reserved' THEN 'in_progress_or_pre_admission'
         WHEN reservation.status IN ('signed', 'submitted') THEN 'provider_effect_evidence'
         WHEN reservation.status IN ('committed', 'released') THEN 'redis_settlement_pending'
         WHEN reservation.status = 'charged_unknown' THEN 'charged_unknown'
         ELSE 'unknown_accounting_state'
       END AS classification
FROM sponsorship_budget_reservations reservation
WHERE NOT COALESCE(reservation.status IN ('committed', 'released'), FALSE)
   OR reservation.redis_settled_at IS NULL
ORDER BY reservation.organization_id, reservation.id;

\echo '=== 3. Executable Payments Approvals that cannot use compatibility replay ==='
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
), audited AS (
  SELECT operation.*,
         EXISTS (
           SELECT 1
           FROM wallet_scope wallet
           WHERE wallet.id = operation.custody_wallet_id
             AND wallet.organization_id = operation.organization_id
             AND wallet.project_id = operation.project_id
             AND wallet.wallet_id = operation.wallet_id
             AND wallet.public_key = operation.raw_payload #>> '{context,sourceAddress}'
         ) AS exact_wallet_matches
  FROM wallet_operations operation
  WHERE operation_type IN ('payment_transfer_execute', 'payment_transfer_batch_execute')
    AND status IN ('pending_approval', 'executing')
)
SELECT id, organization_id, project_id, status, custody_wallet_id,
       execution_lease_expires_at, execution_effect_started_at,
       CASE
         WHEN custody_wallet_id IS NULL THEN 'missing_exact_wallet'
         WHEN NOT exact_wallet_matches THEN 'mismatched_exact_wallet'
         WHEN raw_payload ? 'sourceCustodyWalletId'
           OR (raw_payload #> '{executionRequest,body}') ? 'sourceCustodyWalletId'
           THEN 'unsupported_exact_envelope'
         ELSE 'malformed_legacy_envelope'
       END AS classification
FROM audited
WHERE custody_wallet_id IS NULL
   OR NOT exact_wallet_matches
   OR (
    raw_payload ->> 'source' IS DISTINCT FROM wallet_id
    OR raw_payload ? 'sourceCustodyWalletId'
    OR jsonb_typeof(raw_payload -> 'executionRequest') IS DISTINCT FROM 'object'
    OR raw_payload #>> '{executionRequest,method}' IS DISTINCT FROM 'POST'
    OR (operation_type = 'payment_transfer_execute'
        AND raw_payload #>> '{executionRequest,path}'
            IS DISTINCT FROM '/v1/payments/transfers')
    OR (operation_type = 'payment_transfer_batch_execute'
        AND raw_payload #>> '{executionRequest,path}'
            IS DISTINCT FROM '/v1/payments/transfer-batches')
    OR jsonb_typeof(raw_payload #> '{executionRequest,body}') IS DISTINCT FROM 'object'
    OR raw_payload #>> '{executionRequest,body,source}' IS DISTINCT FROM wallet_id
    OR (raw_payload #> '{executionRequest,body}') ? 'sourceCustodyWalletId'
    OR jsonb_typeof(raw_payload #> '{executionRequest,idempotencyKey}') IS DISTINCT FROM 'string'
  )
ORDER BY classification, organization_id, id
LIMIT 100;

\echo '=== 4. Live approved executions (must drain before catch-up) ==='
SELECT id, organization_id, project_id, operation_type,
       execution_attempt_id, execution_lease_expires_at, execution_effect_started_at
FROM wallet_operations
WHERE operation_type IN ('payment_transfer_execute', 'payment_transfer_batch_execute')
  AND status = 'executing'
  AND execution_lease_expires_at > sdp_iso_now()
ORDER BY execution_lease_expires_at, id;
