-- Product-level outbound recurring payments built on top of the Solana
-- subscriptions program records introduced in 0007.

CREATE TABLE IF NOT EXISTS payment_recurring_payments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    source_wallet_id TEXT NOT NULL,
    source_address TEXT NOT NULL,
    counterparty_id TEXT NOT NULL,
    counterparty_account_id TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    destination_token_account TEXT,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    period_hours INTEGER NOT NULL,
    first_collection_at TEXT,
    next_collection_due_at TEXT,
    plan_id TEXT,
    subscription_id TEXT,
    plan_pda TEXT,
    plan_created_at TEXT,
    plan_creation_signature TEXT,
    subscription_pda TEXT,
    subscription_authority_address TEXT,
    authorization_signature TEXT,
    status TEXT NOT NULL DEFAULT 'pending_activation',
    metadata_uri TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (counterparty_id, organization_id, project_id)
        REFERENCES counterparties(id, organization_id, project_id)
        ON DELETE CASCADE,
    FOREIGN KEY (counterparty_account_id) REFERENCES counterparty_accounts(id) ON DELETE RESTRICT,
    FOREIGN KEY (plan_id) REFERENCES payment_subscription_plans(id) ON DELETE RESTRICT,
    FOREIGN KEY (subscription_id) REFERENCES payment_subscriptions(id) ON DELETE RESTRICT,
    CONSTRAINT payment_recurring_payments_period_hours_positive CHECK (period_hours > 0),
    CONSTRAINT payment_recurring_payments_status_check
        CHECK (status IN ('pending_activation', 'activating', 'active', 'canceling', 'resuming', 'paused', 'canceled', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_project_status_due
    ON payment_recurring_payments(organization_id, project_id, status, next_collection_due_at);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_status_due
    ON payment_recurring_payments(status, next_collection_due_at);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_status_updated
    ON payment_recurring_payments(status, updated_at);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_counterparty_created
    ON payment_recurring_payments(counterparty_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_subscription
    ON payment_recurring_payments(subscription_id)
    WHERE subscription_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_recurring_operation_attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    recurring_payment_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    signature TEXT,
    slot INTEGER,
    block_time TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (recurring_payment_id) REFERENCES payment_recurring_payments(id) ON DELETE CASCADE,
    CONSTRAINT payment_recurring_operation_attempts_operation_check
        CHECK (operation IN ('cancel', 'resume')),
    CONSTRAINT payment_recurring_operation_attempts_status_check
        CHECK (status IN ('processing', 'submitted', 'confirmed', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_operation_attempts_recurring
    ON payment_recurring_operation_attempts(recurring_payment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_operation_attempts_submitted
    ON payment_recurring_operation_attempts(status, updated_at)
    WHERE status IN ('processing', 'submitted');

ALTER TABLE payment_subscription_collection_attempts
    ADD COLUMN IF NOT EXISTS recurring_payment_id TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'payment_subscription_attempts_recurring_payment_id_fkey'
    ) THEN
        ALTER TABLE payment_subscription_collection_attempts
            ADD CONSTRAINT payment_subscription_attempts_recurring_payment_id_fkey
            FOREIGN KEY (recurring_payment_id)
            REFERENCES payment_recurring_payments(id)
            ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payment_subscription_attempts_recurring_created
    ON payment_subscription_collection_attempts(recurring_payment_id, created_at DESC)
    WHERE recurring_payment_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscription_attempts_recurring_due_active
    ON payment_subscription_collection_attempts(recurring_payment_id, due_at)
    WHERE recurring_payment_id IS NOT NULL
      AND status IN ('pending', 'processing', 'confirmed');

CREATE INDEX IF NOT EXISTS idx_payment_subscription_attempts_recurring_submitted
    ON payment_subscription_collection_attempts(recurring_payment_id, updated_at)
    WHERE recurring_payment_id IS NOT NULL
      AND transfer_id IS NOT NULL
      AND signature IS NOT NULL
      AND status IN ('processing', 'confirmed');
