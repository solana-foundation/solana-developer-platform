-- Durable journal for product-level recurring payment activation. These rows
-- let the API recover from partially completed plan/subscription activation.

CREATE TABLE IF NOT EXISTS payment_recurring_payment_activation_attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    recurring_payment_id TEXT NOT NULL,
    plan_id TEXT,
    subscription_id TEXT,
    status TEXT NOT NULL DEFAULT 'processing',
    phase TEXT NOT NULL DEFAULT 'claim',
    plan_creation_signature TEXT,
    authorization_signature TEXT,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (recurring_payment_id) REFERENCES payment_recurring_payments(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES payment_subscription_plans(id) ON DELETE SET NULL,
    FOREIGN KEY (subscription_id) REFERENCES payment_subscriptions(id) ON DELETE SET NULL,
    CONSTRAINT payment_recurring_payment_activation_attempts_status_check
        CHECK (status IN ('processing', 'confirmed', 'failed')),
    CONSTRAINT payment_recurring_payment_activation_attempts_phase_check
        CHECK (phase IN ('claim', 'create_plan', 'authorize_subscription', 'finalize')),
    CONSTRAINT payment_recurring_payment_activation_attempts_metadata_is_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payment_activation_attempts_payment_created
    ON payment_recurring_payment_activation_attempts(recurring_payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payment_activation_attempts_project_status_updated
    ON payment_recurring_payment_activation_attempts(organization_id, project_id, status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_recurring_payment_activation_attempts_processing
    ON payment_recurring_payment_activation_attempts(recurring_payment_id)
    WHERE status = 'processing';
