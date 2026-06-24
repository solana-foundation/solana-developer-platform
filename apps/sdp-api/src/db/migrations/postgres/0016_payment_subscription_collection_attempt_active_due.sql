DROP INDEX IF EXISTS idx_payment_subscription_attempts_active_due;

WITH ranked_attempts AS (
    SELECT
        id,
        status,
        ROW_NUMBER() OVER (
            PARTITION BY organization_id, project_id, subscription_id, due_at
            ORDER BY
                CASE status
                    WHEN 'confirmed' THEN 0
                    WHEN 'processing' THEN 1
                    ELSE 2
                END,
                updated_at DESC,
                created_at DESC,
                id DESC
        ) AS active_due_rank
    FROM payment_subscription_collection_attempts
    WHERE status IN ('pending', 'processing', 'confirmed')
),
duplicate_attempts AS (
    SELECT id, status
    FROM ranked_attempts
    WHERE active_due_rank > 1
)
UPDATE payment_subscription_collection_attempts attempts
   SET status = 'skipped',
       error = COALESCE(
           attempts.error,
           'Skipped duplicate collection attempt before active due uniqueness migration'
       ),
       metadata = attempts.metadata || jsonb_build_object(
           'deduplicatedByMigration',
           '0016_payment_subscription_collection_attempt_active_due',
           'previousStatus',
           duplicate_attempts.status
       ),
       updated_at = sdp_iso_now()
  FROM duplicate_attempts
 WHERE attempts.id = duplicate_attempts.id;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscription_attempts_active_due
    ON payment_subscription_collection_attempts(organization_id, project_id, subscription_id, due_at)
    WHERE status IN ('pending', 'processing', 'confirmed');
