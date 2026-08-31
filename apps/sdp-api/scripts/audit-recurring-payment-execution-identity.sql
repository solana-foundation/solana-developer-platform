\set ON_ERROR_STOP on

-- Read-only cutover and rollback audit. Cutover identity matching retains wallet
-- history; rollback checks mirror the legacy resolver's active-record filters.

\echo '=== 1. Null Recurring Payment identities by exactly-one resolution ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), resolutions AS (
  SELECT recurring.id, recurring.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = recurring.organization_id
            AND ((wallet.owner_kind = 'config'
                  AND (wallet.project_id = recurring.project_id OR wallet.project_id IS NULL))
              OR (wallet.owner_kind = 'connection'
                  AND wallet.project_id = recurring.project_id))
            AND wallet.wallet_id = recurring.source_wallet_id
            AND wallet.public_key = recurring.source_address) AS match_count
  FROM payment_recurring_payments recurring
  WHERE recurring.source_custody_wallet_id IS NULL
)
SELECT status,
       COUNT(*) FILTER (WHERE match_count = 1) AS resolvable_unique,
       COUNT(*) FILTER (WHERE match_count = 0) AS unresolved_zero,
       COUNT(*) FILTER (WHERE match_count > 1) AS ambiguous_multi
FROM resolutions
GROUP BY status
ORDER BY status;

\echo '=== 1a. Unresolved or ambiguous Recurring Payments (up to 100) ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), resolutions AS (
  SELECT recurring.id, recurring.organization_id, recurring.project_id, recurring.status,
         (SELECT COUNT(*) FROM wallet_scope wallet
          WHERE wallet.organization_id = recurring.organization_id
            AND ((wallet.owner_kind = 'config'
                  AND (wallet.project_id = recurring.project_id OR wallet.project_id IS NULL))
              OR (wallet.owner_kind = 'connection'
                  AND wallet.project_id = recurring.project_id))
            AND wallet.wallet_id = recurring.source_wallet_id
            AND wallet.public_key = recurring.source_address) AS match_count
  FROM payment_recurring_payments recurring
  WHERE recurring.source_custody_wallet_id IS NULL
)
SELECT id, organization_id, project_id, status, match_count
FROM resolutions
WHERE match_count <> 1
ORDER BY organization_id, id
LIMIT 100;

\echo '=== 1b. Rollback-incompatible recurring wallet resolution (must be zero before rollback) ==='
WITH legacy_wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  WHERE wallet.status = 'active' AND config.status = 'active'
  UNION ALL
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
  WHERE wallet.status = 'active' AND connection.status = 'active'
), resolutions AS (
  SELECT recurring.id, recurring.organization_id, recurring.project_id,
         recurring.source_custody_wallet_id, recurring.status,
         CASE WHEN COUNT(wallet.id) = 1 THEN MIN(wallet.id) END
           AS legacy_custody_wallet_id,
         COUNT(wallet.id)::INTEGER AS provider_match_count,
         COUNT(wallet.id) FILTER (
           WHERE wallet.public_key = recurring.source_address
         )::INTEGER AS evidence_match_count
  FROM payment_recurring_payments recurring
  LEFT JOIN legacy_wallet_scope wallet
    ON wallet.organization_id = recurring.organization_id
   AND ((wallet.owner_kind = 'config'
         AND (wallet.project_id = recurring.project_id OR wallet.project_id IS NULL))
     OR (wallet.owner_kind = 'connection'
         AND wallet.project_id = recurring.project_id))
   AND wallet.wallet_id = recurring.source_wallet_id
  GROUP BY recurring.id, recurring.organization_id, recurring.project_id,
           recurring.source_custody_wallet_id, recurring.status
)
SELECT id, organization_id, project_id, source_custody_wallet_id,
       legacy_custody_wallet_id, status,
       provider_match_count, evidence_match_count
FROM resolutions
WHERE provider_match_count <> 1
   OR evidence_match_count <> 1
   OR (source_custody_wallet_id IS NOT NULL
       AND legacy_custody_wallet_id IS DISTINCT FROM source_custody_wallet_id)
ORDER BY organization_id, id
LIMIT 100;

\echo '=== 2. Persisted recurring pins that disagree with retained evidence (must be zero) ==='
WITH wallet_scope AS (
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         config.organization_id, config.project_id, 'config'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_configs config ON config.id = wallet.custody_config_id
  UNION ALL
  SELECT wallet.id, wallet.wallet_id, wallet.public_key,
         connection.organization_id, connection.project_id, 'connection'::TEXT AS owner_kind
  FROM custody_wallets wallet
  JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
), mismatches AS (
  SELECT 'recurring_payment'::TEXT AS resource, recurring.id,
         recurring.source_custody_wallet_id AS custody_wallet_id
  FROM payment_recurring_payments recurring
  WHERE recurring.source_custody_wallet_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM wallet_scope wallet
      WHERE wallet.id = recurring.source_custody_wallet_id
        AND wallet.organization_id = recurring.organization_id
        AND ((wallet.owner_kind = 'config'
              AND (wallet.project_id = recurring.project_id OR wallet.project_id IS NULL))
          OR (wallet.owner_kind = 'connection' AND wallet.project_id = recurring.project_id))
        AND wallet.wallet_id = recurring.source_wallet_id
        AND wallet.public_key = recurring.source_address
    )
  UNION ALL
  SELECT 'update_attempt', attempt.id, attempt.new_source_custody_wallet_id
  FROM payment_recurring_payment_update_attempts attempt
  WHERE attempt.new_source_custody_wallet_id IS NOT NULL
    AND (
      NOT EXISTS (
        SELECT 1 FROM wallet_scope wallet
        WHERE wallet.id = attempt.new_source_custody_wallet_id
          AND wallet.organization_id = attempt.organization_id
          AND ((wallet.owner_kind = 'config'
                AND (wallet.project_id = attempt.project_id OR wallet.project_id IS NULL))
            OR (wallet.owner_kind = 'connection' AND wallet.project_id = attempt.project_id))
      )
      OR (
        attempt.changed_fields @> ARRAY['sourceCustodyWalletId']::TEXT[]
        AND attempt.after_values ->> 'sourceCustodyWalletId'
            IS DISTINCT FROM attempt.new_source_custody_wallet_id
      )
    )
)
SELECT * FROM mismatches ORDER BY resource, id LIMIT 100;

\echo '=== 2a. Source-changing update attempts without their proposed exact pin (must be zero) ==='
SELECT id, organization_id, project_id, recurring_payment_id, status, stage
FROM payment_recurring_payment_update_attempts
WHERE changed_fields && ARRAY['sourceCustodyWalletId', 'sourceWalletId']::TEXT[]
  AND new_source_custody_wallet_id IS NULL
ORDER BY organization_id, id
LIMIT 100;

\echo '=== 3. Transitional Recurring Payment parents (must be zero before rollback) ==='
SELECT id, organization_id, project_id, status, updated_at
FROM payment_recurring_payments
WHERE status IN ('activating', 'updating', 'canceling', 'resuming')
ORDER BY organization_id, project_id, id;

\echo '=== 4. Processing Recurring Payment attempts (must be zero before rollback) ==='
SELECT 'activation'::TEXT AS attempt_kind,
       id, organization_id, project_id, recurring_payment_id, status, stage, updated_at
FROM payment_recurring_payment_activation_attempts
WHERE status = 'processing'
UNION ALL
SELECT 'update'::TEXT,
       id, organization_id, project_id, recurring_payment_id, status, stage, updated_at
FROM payment_recurring_payment_update_attempts
WHERE status = 'processing'
UNION ALL
SELECT 'lifecycle'::TEXT,
       id, organization_id, project_id, recurring_payment_id, status, stage, updated_at
FROM payment_recurring_payment_lifecycle_attempts
WHERE status = 'processing'
ORDER BY attempt_kind, organization_id, project_id, id;

\echo '=== 5. Incompatible unfinished Recurring Payment Approvals (must be zero before rollback) ==='
SELECT operation.id AS wallet_operation_id,
       operation.organization_id,
       operation.project_id,
       operation.operation_type,
       operation.status AS operation_status,
       operation.custody_wallet_id,
       approval.id AS approval_request_id,
       approval.status AS approval_status
FROM wallet_operations operation
JOIN approval_requests approval
  ON approval.wallet_operation_id = operation.id
WHERE operation.operation_type IN (
        'recurring_payment_create',
        'recurring_payment_update',
        'recurring_payment_collection'
      )
  AND operation.status IN ('pending_approval', 'executing')
  AND approval.status IN ('pending', 'approved')
ORDER BY operation.organization_id, operation.id, approval.id;
