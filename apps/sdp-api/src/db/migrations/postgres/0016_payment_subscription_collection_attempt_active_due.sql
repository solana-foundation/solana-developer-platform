CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscription_attempts_active_due
    ON payment_subscription_collection_attempts(organization_id, project_id, subscription_id, due_at)
    WHERE status IN ('pending', 'processing');
