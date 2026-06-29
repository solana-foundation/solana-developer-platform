-- Durable update attempts and audit history for recurring payment edits.

ALTER TABLE payment_recurring_payments
    DROP CONSTRAINT IF EXISTS payment_recurring_payments_status_check;

ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_status_check
        CHECK (status IN (
            'pending_activation',
            'activating',
            'active',
            'updating',
            'canceling',
            'resuming',
            'paused',
            'canceled',
            'expired'
        ));

CREATE TABLE IF NOT EXISTS payment_recurring_payment_update_attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    recurring_payment_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    stage TEXT NOT NULL,
    old_plan_id TEXT,
    old_subscription_id TEXT,
    new_plan_id TEXT,
    new_subscription_id TEXT,
    plan_update_signature TEXT,
    plan_creation_signature TEXT,
    authorization_setup_signature TEXT,
    authorization_signature TEXT,
    old_cancel_signature TEXT,
    changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    before_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (recurring_payment_id) REFERENCES payment_recurring_payments(id) ON DELETE CASCADE,
    FOREIGN KEY (old_plan_id) REFERENCES payment_subscription_plans(id) ON DELETE SET NULL,
    FOREIGN KEY (old_subscription_id) REFERENCES payment_subscriptions(id) ON DELETE SET NULL,
    FOREIGN KEY (new_plan_id) REFERENCES payment_subscription_plans(id) ON DELETE SET NULL,
    FOREIGN KEY (new_subscription_id) REFERENCES payment_subscriptions(id) ON DELETE SET NULL,
    CONSTRAINT payment_recurring_payment_update_attempts_mode_check
        CHECK (mode IN ('metadata_schedule', 'replacement')),
    CONSTRAINT payment_recurring_payment_update_attempts_status_check
        CHECK (status IN ('processing', 'confirmed', 'failed')),
    CONSTRAINT payment_recurring_payment_update_attempts_stage_check
        CHECK (stage IN (
            'claim',
            'update_plan',
            'create_plan',
            'authorize_subscription',
            'cancel_old_subscription',
            'finalize'
        )),
    CONSTRAINT payment_recurring_payment_update_attempts_before_is_object
        CHECK (jsonb_typeof(before_values) = 'object'),
    CONSTRAINT payment_recurring_payment_update_attempts_after_is_object
        CHECK (jsonb_typeof(after_values) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payment_update_attempts_payment_created
    ON payment_recurring_payment_update_attempts(recurring_payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payment_update_attempts_project_status
    ON payment_recurring_payment_update_attempts(organization_id, project_id, status, updated_at);

CREATE TABLE IF NOT EXISTS payment_recurring_payment_update_events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    recurring_payment_id TEXT NOT NULL,
    attempt_id TEXT,
    changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    before_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (recurring_payment_id) REFERENCES payment_recurring_payments(id) ON DELETE CASCADE,
    FOREIGN KEY (attempt_id) REFERENCES payment_recurring_payment_update_attempts(id) ON DELETE SET NULL,
    CONSTRAINT payment_recurring_payment_update_events_before_is_object
        CHECK (jsonb_typeof(before_values) = 'object'),
    CONSTRAINT payment_recurring_payment_update_events_after_is_object
        CHECK (jsonb_typeof(after_values) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payment_update_events_payment_created
    ON payment_recurring_payment_update_events(recurring_payment_id, created_at DESC);
