-- Durable activation attempts for Recurring Payments. These rows make failed
-- and resumed activation runs inspectable without exposing collection state.

CREATE TABLE IF NOT EXISTS payment_recurring_payment_activation_attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    recurring_payment_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'processing',
    stage TEXT NOT NULL,
    plan_creation_signature TEXT,
    authorization_signature TEXT,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (recurring_payment_id) REFERENCES payment_recurring_payments(id) ON DELETE CASCADE,
    CONSTRAINT payment_recurring_payment_activation_attempts_status_check
        CHECK (status IN ('processing', 'confirmed', 'failed')),
    CONSTRAINT payment_recurring_payment_activation_attempts_stage_check
        CHECK (stage IN ('claim', 'create_plan', 'authorize_subscription', 'finalize')),
    CONSTRAINT payment_recurring_payment_activation_attempts_metadata_is_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payment_activation_attempts_payment_created
    ON payment_recurring_payment_activation_attempts(recurring_payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payment_activation_attempts_project_status
    ON payment_recurring_payment_activation_attempts(organization_id, project_id, status, updated_at);
