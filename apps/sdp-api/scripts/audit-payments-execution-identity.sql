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

\echo '=== 2b. Unresolved nonterminal Payment Requests (review before cutover) ==='
SELECT id, organization_id, project_id, status
FROM payment_requests
WHERE status = 'awaiting_payment'
  AND custody_wallet_id IS NULL
ORDER BY organization_id, id
LIMIT 100;

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

-- BEGIN recurring exact identity
-- No status filter: canceled/paused history and unfinished replacements retain
-- their own roles. This report proves identity only, not execution eligibility.
\echo '=== Recurring retained role and replacement-source evidence ==='
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
), roles AS (
  SELECT 'plan_owner'::TEXT AS resource, plan.id, plan.organization_id,
         plan.project_id, plan.status, plan.owner_custody_wallet_id AS custody_wallet_id,
         plan.owner_wallet_id AS provider_wallet_id, plan.owner_address AS saved_address,
         FALSE AS absent_optional_role, NULL::TEXT AS expected_custody_wallet_id,
         NULL::TEXT AS linked_plan_pin, plan.role_projection_revision AS projection_revision
  FROM payment_subscription_plans plan
  UNION ALL
  SELECT 'plan_puller', plan.id, plan.organization_id, plan.project_id, plan.status,
         plan.puller_custody_wallet_id, plan.puller_wallet_id, plan.puller_address,
         plan.puller_custody_wallet_id IS NULL
           AND plan.puller_wallet_id IS NULL AND plan.puller_address IS NULL,
         NULL, NULL, plan.role_projection_revision
  FROM payment_subscription_plans plan
  UNION ALL
  SELECT 'recurring_source', recurring.id, recurring.organization_id,
         recurring.project_id, recurring.status, recurring.source_custody_wallet_id,
         recurring.source_wallet_id, recurring.source_address, FALSE, NULL, NULL, NULL
  FROM payment_recurring_payments recurring
  UNION ALL
  SELECT 'replacement_source', attempt.id, attempt.organization_id,
         attempt.project_id, attempt.status, attempt.new_source_custody_wallet_id,
         plan.owner_wallet_id, plan.owner_address, FALSE,
         attempt.after_values ->> 'sourceCustodyWalletId', plan.owner_custody_wallet_id, plan.role_projection_revision
  FROM payment_recurring_payment_update_attempts attempt
  LEFT JOIN payment_subscription_plans plan
    ON plan.id = attempt.new_plan_id
   AND plan.organization_id = attempt.organization_id
   AND plan.project_id = attempt.project_id
  WHERE attempt.mode = 'replacement'
  UNION ALL
  SELECT 'replacement_old_plan_owner', attempt.id, attempt.organization_id,
         attempt.project_id, attempt.status, plan.owner_custody_wallet_id,
         plan.owner_wallet_id, plan.owner_address, FALSE, NULL, NULL, plan.role_projection_revision
  FROM payment_recurring_payment_update_attempts attempt
  LEFT JOIN payment_subscription_plans plan
    ON plan.id = attempt.old_plan_id
   AND plan.organization_id = attempt.organization_id
   AND plan.project_id = attempt.project_id
  WHERE attempt.mode = 'replacement'
  UNION ALL
  SELECT 'replacement_old_plan_puller', attempt.id, attempt.organization_id,
         attempt.project_id, attempt.status, plan.puller_custody_wallet_id,
         plan.puller_wallet_id, plan.puller_address, plan.id IS NOT NULL AND plan.puller_custody_wallet_id IS NULL AND plan.puller_wallet_id IS NULL AND plan.puller_address IS NULL, NULL, NULL, plan.role_projection_revision
  FROM payment_recurring_payment_update_attempts attempt
  LEFT JOIN payment_subscription_plans plan
    ON plan.id = attempt.old_plan_id
   AND plan.organization_id = attempt.organization_id
   AND plan.project_id = attempt.project_id
  WHERE attempt.mode = 'replacement'
  UNION ALL
  SELECT 'replacement_new_plan_owner', attempt.id, attempt.organization_id,
         attempt.project_id, attempt.status, plan.owner_custody_wallet_id,
         plan.owner_wallet_id, plan.owner_address, FALSE, NULL, NULL, plan.role_projection_revision
  FROM payment_recurring_payment_update_attempts attempt
  LEFT JOIN payment_subscription_plans plan
    ON plan.id = attempt.new_plan_id
   AND plan.organization_id = attempt.organization_id
   AND plan.project_id = attempt.project_id
  WHERE attempt.mode = 'replacement'
  UNION ALL
  SELECT 'replacement_new_plan_puller', attempt.id, attempt.organization_id,
         attempt.project_id, attempt.status, plan.puller_custody_wallet_id,
         plan.puller_wallet_id, plan.puller_address, plan.id IS NOT NULL AND plan.puller_custody_wallet_id IS NULL AND plan.puller_wallet_id IS NULL AND plan.puller_address IS NULL, NULL, NULL, plan.role_projection_revision
  FROM payment_recurring_payment_update_attempts attempt
  LEFT JOIN payment_subscription_plans plan
    ON plan.id = attempt.new_plan_id
   AND plan.organization_id = attempt.organization_id
   AND plan.project_id = attempt.project_id
  WHERE attempt.mode = 'replacement'
), resolutions AS (
  SELECT roles.*,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = roles.organization_id
            AND wallet.project_id = roles.project_id
            AND wallet.wallet_id = roles.provider_wallet_id
            AND wallet.public_key = roles.saved_address
            AND (roles.expected_custody_wallet_id IS NULL
                 OR wallet.id = roles.expected_custody_wallet_id)
            AND (roles.linked_plan_pin IS NULL OR wallet.id = roles.linked_plan_pin)
         ) AS match_count,
         EXISTS (
           SELECT 1 FROM wallet_scope wallet
           WHERE wallet.id = roles.custody_wallet_id
             AND wallet.organization_id = roles.organization_id
             AND wallet.project_id = roles.project_id
             AND wallet.wallet_id = roles.provider_wallet_id
             AND wallet.public_key = roles.saved_address
             AND (roles.expected_custody_wallet_id IS NULL
                  OR wallet.id = roles.expected_custody_wallet_id)
             AND (roles.linked_plan_pin IS NULL OR wallet.id = roles.linked_plan_pin)
         ) AS pin_matches
  FROM roles
)
SELECT resource, id, organization_id, project_id, status, custody_wallet_id,
       provider_wallet_id, saved_address, projection_revision, match_count,
       CASE
         WHEN absent_optional_role THEN 'absent_optional_role'
         WHEN custody_wallet_id IS NOT NULL AND NOT pin_matches THEN 'inconsistent_pin'
         WHEN custody_wallet_id IS NOT NULL AND projection_revision = 0 THEN 'unfenced_pin'
         WHEN custody_wallet_id IS NOT NULL THEN 'exact_pin'
         WHEN match_count = 1 THEN 'resolvable_unique'
         WHEN match_count > 1 THEN 'ambiguous_multi'
         ELSE 'unresolved_zero'
       END AS classification
FROM resolutions
ORDER BY resource, organization_id, project_id, id;
-- END recurring exact identity

-- BEGIN recurring accounting readiness
-- Never infer reservation/effect absence from a missing link or parent status.
\echo '=== Recurring concrete-message accounting and unfinished-attempt readiness ==='
WITH recurring_subscriptions AS (
  SELECT parent.id AS recurring_payment_id, parent.organization_id,
         parent.project_id, parent.subscription_id
  FROM payment_recurring_payments parent
  WHERE parent.subscription_id IS NOT NULL
  UNION
  SELECT attempt.recurring_payment_id, attempt.organization_id,
         attempt.project_id, attempt.old_subscription_id
  FROM payment_recurring_payment_update_attempts attempt
  WHERE attempt.old_subscription_id IS NOT NULL
  UNION
  SELECT attempt.recurring_payment_id, attempt.organization_id,
         attempt.project_id, attempt.new_subscription_id
  FROM payment_recurring_payment_update_attempts attempt
  WHERE attempt.new_subscription_id IS NOT NULL
), messages AS (
  SELECT 'activation'::TEXT AS attempt_kind, attempt.id AS attempt_id,
         attempt.recurring_payment_id, attempt.organization_id, attempt.project_id,
         attempt.status AS attempt_status, attempt.stage, NULL::TEXT AS due_at,
         message.key AS message_key,
         CASE WHEN attempt.status = 'confirmed' THEN NULL::TEXT
              ELSE parent.source_custody_wallet_id END AS expected_wallet_id,
         CASE message.key
           WHEN 'create_plan' THEN attempt.plan_creation_signature
           WHEN 'authorization_setup' THEN attempt.metadata ->> 'authorizationSetupSignature'
           ELSE attempt.authorization_signature
         END AS saved_signature
  FROM payment_recurring_payment_activation_attempts attempt
  CROSS JOIN (VALUES ('create_plan'), ('authorization_setup'), ('authorize_subscription')) message(key)
  LEFT JOIN payment_recurring_payments parent
    ON parent.id = attempt.recurring_payment_id
   AND parent.organization_id = attempt.organization_id
   AND parent.project_id = attempt.project_id
  UNION ALL
  SELECT 'lifecycle', attempt.id, attempt.recurring_payment_id,
         attempt.organization_id, attempt.project_id, attempt.status, attempt.stage,
         NULL, attempt.operation,
         CASE WHEN attempt.status = 'confirmed' THEN NULL::TEXT
              ELSE parent.source_custody_wallet_id END, attempt.signature
  FROM payment_recurring_payment_lifecycle_attempts attempt
  LEFT JOIN payment_recurring_payments parent
    ON parent.id = attempt.recurring_payment_id
   AND parent.organization_id = attempt.organization_id
   AND parent.project_id = attempt.project_id
  UNION ALL
  SELECT 'update', attempt.id, attempt.recurring_payment_id,
         attempt.organization_id, attempt.project_id, attempt.status, attempt.stage,
         NULL, message.key,
         CASE WHEN message.key IN ('update_plan', 'cancel_old')
              THEN COALESCE(attempt.before_values ->> 'sourceCustodyWalletId', old_plan.owner_custody_wallet_id)
              ELSE COALESCE(attempt.new_source_custody_wallet_id,
                            attempt.after_values ->> 'sourceCustodyWalletId', new_plan.owner_custody_wallet_id)
         END,
         CASE message.key
           WHEN 'update_plan' THEN attempt.plan_update_signature
           WHEN 'create_plan' THEN attempt.plan_creation_signature
           WHEN 'authorization_setup' THEN attempt.authorization_setup_signature
           WHEN 'cancel_old' THEN attempt.old_cancel_signature
           ELSE attempt.authorization_signature
         END
  FROM payment_recurring_payment_update_attempts attempt
  CROSS JOIN (VALUES ('update_plan'), ('create_plan'), ('authorization_setup'),
                     ('authorize_subscription'), ('cancel_old')) message(key)
  LEFT JOIN payment_subscription_plans old_plan
    ON old_plan.id = attempt.old_plan_id
   AND old_plan.organization_id = attempt.organization_id
   AND old_plan.project_id = attempt.project_id
  LEFT JOIN payment_subscription_plans new_plan
    ON new_plan.id = attempt.new_plan_id
   AND new_plan.organization_id = attempt.organization_id
   AND new_plan.project_id = attempt.project_id
  WHERE (attempt.mode = 'metadata_schedule' AND message.key = 'update_plan')
     OR (attempt.mode = 'replacement' AND message.key <> 'update_plan')
  UNION ALL
  SELECT 'collection', attempt.id, history.recurring_payment_id, attempt.organization_id,
         attempt.project_id, attempt.status, 'collect', attempt.due_at,
         'collect',
         CASE WHEN plan.puller_custody_wallet_id IS NULL AND plan.puller_wallet_id IS NULL
                   AND plan.puller_address IS NULL THEN plan.owner_custody_wallet_id
              ELSE plan.puller_custody_wallet_id END,
         attempt.signature
  FROM payment_subscription_collection_attempts attempt
  JOIN recurring_subscriptions history
    ON history.subscription_id = attempt.subscription_id
   AND history.organization_id = attempt.organization_id
   AND history.project_id = attempt.project_id
  LEFT JOIN payment_subscriptions subscription
    ON subscription.id = attempt.subscription_id
   AND subscription.organization_id = attempt.organization_id
   AND subscription.project_id = attempt.project_id
  LEFT JOIN payment_subscription_plans plan
    ON plan.id = subscription.plan_id
   AND plan.organization_id = subscription.organization_id
   AND plan.project_id = subscription.project_id

), audited AS (
  SELECT COALESCE(message.attempt_kind, link.attempt_kind) AS attempt_kind,
         COALESCE(message.attempt_id, link.attempt_id) AS attempt_id,
         COALESCE(link.message_key, message.message_key) AS message_key,
         COALESCE(message.recurring_payment_id, link.recurring_payment_id) AS recurring_payment_id,
         COALESCE(message.organization_id, link.organization_id) AS organization_id,
         COALESCE(message.project_id, link.project_id) AS project_id,
         message.attempt_status, message.stage, message.due_at, message.saved_signature,
         CASE WHEN link.confirmed_failure_signature IS NOT NULL
                   AND ((link.deployment_mode = 'self_hosted'
                         AND link.submission_signature = link.confirmed_failure_signature)
                        OR (reservation.status = 'committed'
                            AND reservation.signature = link.confirmed_failure_signature))
              THEN NULL::TEXT ELSE message.expected_wallet_id END AS expected_wallet_id,
         link.custody_wallet_id, link.deployment_mode,
         link.reservation_id, reservation.status AS reservation_status,
         link.admission_started_at, link.confirmed_failure_signature, link.submission_signature,
         CASE
           WHEN message.attempt_id IS NULL THEN 'orphan_linkage'
           WHEN link.attempt_id IS NULL AND message.attempt_status = 'confirmed' THEN 'historical_unlinked'
           WHEN link.attempt_id IS NULL THEN 'missing_linkage'
           WHEN link.organization_id IS DISTINCT FROM message.organization_id
             OR link.project_id IS DISTINCT FROM message.project_id
             OR link.recurring_payment_id IS DISTINCT FROM message.recurring_payment_id
             OR ((message.attempt_status <> 'confirmed'
                  OR message.attempt_kind NOT IN ('activation', 'lifecycle'))
                 AND NOT (link.confirmed_failure_signature IS NOT NULL
                          AND ((link.deployment_mode = 'self_hosted'
                                AND link.submission_signature = link.confirmed_failure_signature)
                               OR (reservation.status = 'committed'
                                   AND reservation.signature = link.confirmed_failure_signature)))
                 AND link.custody_wallet_id IS DISTINCT FROM message.expected_wallet_id)
             THEN 'inconsistent_domain_identity'
           WHEN (link.reservation_id IS NULL) <> (link.accounting_identity IS NULL)
             OR (link.deployment_mode = 'self_hosted' AND link.reservation_id IS NOT NULL)
             OR (link.accounting_identity IS NOT NULL AND (
               reservation.id IS NULL
               OR link.accounting_identity ->> 'reservationId' IS DISTINCT FROM link.reservation_id
               OR link.accounting_identity ->> 'organizationId' IS DISTINCT FROM link.organization_id
               OR link.accounting_identity ->> 'projectId' IS DISTINCT FROM link.project_id
               OR link.accounting_identity #>> '{actor,type}' IS DISTINCT FROM 'wallet'
               OR link.accounting_identity #>> '{actor,id}' IS DISTINCT FROM link.legacy_actor_id
               OR reservation.organization_id IS DISTINCT FROM link.organization_id
               OR reservation.project_id IS DISTINCT FROM link.project_id
               OR reservation.actor_type IS DISTINCT FROM 'wallet'
               OR reservation.actor_id IS DISTINCT FROM link.legacy_actor_id
               OR link.accounting_identity ->> 'attempt' IS DISTINCT FROM reservation.attempt::TEXT
               OR link.accounting_identity ->> 'network' IS DISTINCT FROM reservation.network
               OR link.accounting_identity ->> 'environment' IS DISTINCT FROM reservation.product_environment
               OR link.accounting_identity ->> 'transactionDigest' IS DISTINCT FROM reservation.transaction_digest
               OR link.accounting_identity ->> 'feePayer' IS DISTINCT FROM reservation.fee_payer
               OR link.accounting_identity ->> 'providerConfigFingerprint' IS DISTINCT FROM reservation.provider_config_fingerprint
             )) THEN 'inconsistent_accounting'
           WHEN EXISTS (
             SELECT 1 FROM payment_recurring_sponsorship_links other
             WHERE other.attempt_kind = link.attempt_kind AND other.attempt_id = link.attempt_id
               AND other.deployment_mode <> link.deployment_mode
           ) THEN 'mode_conflict'
           WHEN POSITION(':' IN link.message_key) > 0 AND NOT EXISTS (
             SELECT 1 FROM payment_recurring_sponsorship_links previous
             LEFT JOIN sponsorship_budget_reservations previous_reservation
               ON previous_reservation.id = previous.reservation_id
             WHERE previous.organization_id = link.organization_id
               AND previous.project_id = link.project_id
               AND previous.recurring_payment_id = link.recurring_payment_id
               AND previous.attempt_kind = link.attempt_kind
               AND previous.attempt_id = link.attempt_id
               AND split_part(previous.message_key, ':', 1) = split_part(link.message_key, ':', 1)
               AND previous.confirmed_failure_signature = split_part(link.message_key, ':', 2)
               AND previous.custody_wallet_id = link.custody_wallet_id
               AND previous.legacy_actor_id = link.legacy_actor_id
               AND previous.deployment_mode = link.deployment_mode
               AND ((previous.deployment_mode = 'self_hosted'
                     AND previous.submission_signature = previous.confirmed_failure_signature)
                    OR (previous_reservation.status = 'committed'
                        AND previous_reservation.signature = previous.confirmed_failure_signature))
           ) THEN 'inconsistent_retry_evidence'
           WHEN reservation.status = 'charged_unknown' THEN 'unknown_outcome'
           WHEN link.deployment_mode = 'self_hosted' AND link.confirmed_failure_signature IS NOT NULL
             AND link.submission_signature IS DISTINCT FROM link.confirmed_failure_signature
             THEN 'inconsistent_failure_evidence'
           WHEN link.confirmed_failure_signature IS NOT NULL
             AND link.deployment_mode = 'managed'
             AND (reservation.status IS DISTINCT FROM 'committed'
                  OR reservation.signature IS DISTINCT FROM link.confirmed_failure_signature)
             THEN 'inconsistent_failure_evidence'
           WHEN link.deployment_mode = 'managed' AND link.reservation_id IS NULL
             AND link.admission_started_at IS NOT NULL THEN 'started_without_accounting'
           WHEN link.deployment_mode = 'managed' AND link.reservation_id IS NULL
             AND message.saved_signature IS NOT NULL THEN 'signed_without_accounting'
           WHEN link.deployment_mode = 'managed' AND link.reservation_id IS NULL
             THEN 'unadmitted_message_requires_absence_proof'
           WHEN link.confirmed_failure_signature IS NOT NULL
             THEN 'confirmed_failure_retained_evidence'
           -- A later source replacement cannot prove or disprove a completed
           -- attempt's historical role; retained accounting is audited separately.
           WHEN message.attempt_status = 'confirmed'
             AND message.attempt_kind IN ('activation', 'lifecycle')
             THEN CASE WHEN link.deployment_mode = 'self_hosted'
                       THEN 'historical_self_hosted_evidence'
                       ELSE 'historical_linked_accounting' END
           WHEN link.deployment_mode = 'self_hosted' THEN 'self_hosted_evidence'
           ELSE 'linked_accounting'
         END AS classification
  FROM messages message
  FULL OUTER JOIN payment_recurring_sponsorship_links link
    ON link.attempt_kind = message.attempt_kind AND link.attempt_id = message.attempt_id
   AND split_part(link.message_key, ':', 1) = message.message_key
  LEFT JOIN sponsorship_budget_reservations reservation ON reservation.id = link.reservation_id
)
SELECT * FROM audited
ORDER BY organization_id, project_id, recurring_payment_id, attempt_kind, attempt_id, message_key;
-- END recurring accounting readiness
