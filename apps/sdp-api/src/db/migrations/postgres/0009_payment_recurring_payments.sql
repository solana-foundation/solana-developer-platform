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

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_project_source_wallet_created
    ON payment_recurring_payments(organization_id, project_id, source_wallet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_subscription
    ON payment_recurring_payments(subscription_id)
    WHERE subscription_id IS NOT NULL;
