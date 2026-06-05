-- Recurring payment subscriptions. These tables store SDP's backend state for
-- Solana Program Library subscriptions while the on-chain records remain the
-- settlement/source of truth for authorization and collection.

CREATE TABLE IF NOT EXISTS payment_subscription_plans (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    owner_wallet_id TEXT NOT NULL,
    owner_address TEXT NOT NULL,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    period_hours INTEGER NOT NULL,
    program_plan_id TEXT NOT NULL,
    plan_pda TEXT,
    destination_address TEXT,
    puller_wallet_id TEXT,
    puller_address TEXT,
    metadata_uri TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT payment_subscription_plans_period_hours_positive CHECK (period_hours > 0),
    CONSTRAINT payment_subscription_plans_status_check
        CHECK (status IN ('draft', 'active', 'archived'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscription_plans_program_plan
    ON payment_subscription_plans(organization_id, project_id, program_plan_id);

CREATE INDEX IF NOT EXISTS idx_payment_subscription_plans_project_status_created
    ON payment_subscription_plans(organization_id, project_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscription_plans_plan_pda
    ON payment_subscription_plans(plan_pda)
    WHERE plan_pda IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment_subscriptions (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    plan_id TEXT NOT NULL,
    counterparty_id TEXT NOT NULL,
    subscriber_address TEXT NOT NULL,
    subscriber_token_account TEXT,
    subscription_pda TEXT,
    subscription_authority_address TEXT,
    authorization_signature TEXT,
    status TEXT NOT NULL DEFAULT 'pending_authorization',
    current_period_start_at TEXT,
    next_collection_due_at TEXT,
    cancel_at TEXT,
    canceled_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (plan_id) REFERENCES payment_subscription_plans(id) ON DELETE CASCADE,
    FOREIGN KEY (counterparty_id, organization_id, project_id)
        REFERENCES counterparties(id, organization_id, project_id)
        ON DELETE CASCADE,
    CONSTRAINT payment_subscriptions_status_check
        CHECK (status IN (
            'pending_authorization',
            'active',
            'paused',
            'canceling',
            'canceled',
            'expired'
        ))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscriptions_counterparty_plan
    ON payment_subscriptions(organization_id, project_id, plan_id, counterparty_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscriptions_subscription_pda
    ON payment_subscriptions(subscription_pda)
    WHERE subscription_pda IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_subscriptions_project_status_due
    ON payment_subscriptions(organization_id, project_id, status, next_collection_due_at);

CREATE INDEX IF NOT EXISTS idx_payment_subscriptions_counterparty_created
    ON payment_subscriptions(counterparty_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_subscription_collection_attempts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    transfer_id TEXT,
    token TEXT NOT NULL,
    amount TEXT NOT NULL,
    due_at TEXT NOT NULL,
    attempted_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    signature TEXT,
    error TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (subscription_id) REFERENCES payment_subscriptions(id) ON DELETE CASCADE,
    FOREIGN KEY (transfer_id) REFERENCES payment_transfers(id) ON DELETE SET NULL,
    CONSTRAINT payment_subscription_collection_attempts_status_check
        CHECK (status IN ('pending', 'processing', 'confirmed', 'failed', 'skipped')),
    CONSTRAINT payment_subscription_collection_attempts_metadata_is_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_payment_subscription_attempts_subscription_created
    ON payment_subscription_collection_attempts(subscription_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_subscription_attempts_project_status_due
    ON payment_subscription_collection_attempts(organization_id, project_id, status, due_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_subscription_attempts_signature
    ON payment_subscription_collection_attempts(signature)
    WHERE signature IS NOT NULL;
