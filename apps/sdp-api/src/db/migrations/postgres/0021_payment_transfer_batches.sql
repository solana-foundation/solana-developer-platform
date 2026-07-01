-- Transfer batches group many logical recipient payments into one or more
-- on-chain transfer transactions. `payment_transfers` remains the
-- execution/signature table: implementation should create one transfer row per
-- Solana transaction chunk, while recipient-level status lives here.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'counterparty_accounts_id_counterparty_org_project_key'
    ) THEN
        ALTER TABLE counterparty_accounts ADD CONSTRAINT counterparty_accounts_id_counterparty_org_project_key
            UNIQUE (id, counterparty_id, organization_id, project_id);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'payment_transfers_id_org_project_key'
    ) THEN
        ALTER TABLE payment_transfers ADD CONSTRAINT payment_transfers_id_org_project_key
            UNIQUE (id, organization_id, project_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS payment_transfer_batches (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    external_id TEXT,
    source_wallet_id TEXT NOT NULL,
    source_address TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    total_amount TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    transaction_count INTEGER NOT NULL DEFAULT 0,
    options JSONB NOT NULL DEFAULT '{}'::jsonb,
    error TEXT,
    initiated_by_key_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT payment_transfer_batches_options_is_object CHECK (jsonb_typeof(options) = 'object'),
    CONSTRAINT payment_transfer_batches_status_check CHECK (
        status IN ('pending', 'processing', 'confirmed', 'failed', 'partially_failed', 'archived')
    ),
    CONSTRAINT payment_transfer_batches_counts_nonnegative CHECK (
        recipient_count >= 0 AND transaction_count >= 0
    ),
    CONSTRAINT payment_transfer_batches_id_org_project_key UNIQUE (id, organization_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_payment_transfer_batches_org_created
    ON payment_transfer_batches(organization_id, created_at DESC)
    WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_payment_transfer_batches_project_created
    ON payment_transfer_batches(project_id, created_at DESC)
    WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_payment_transfer_batches_wallet_created
    ON payment_transfer_batches(source_wallet_id, created_at DESC)
    WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_payment_transfer_batches_status_created
    ON payment_transfer_batches(status, created_at DESC)
    WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_payment_transfer_batches_external_id
    ON payment_transfer_batches(organization_id, external_id)
    WHERE external_id IS NOT NULL AND status <> 'archived';

CREATE TABLE IF NOT EXISTS payment_transfer_recipients (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    transfer_id TEXT,
    external_id TEXT,
    counterparty_id TEXT NOT NULL,
    counterparty_account_id TEXT NOT NULL,
    destination_address TEXT NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (batch_id, organization_id, project_id)
        REFERENCES payment_transfer_batches(id, organization_id, project_id)
        ON DELETE CASCADE,
    FOREIGN KEY (transfer_id, organization_id, project_id)
        REFERENCES payment_transfers(id, organization_id, project_id),
    FOREIGN KEY (counterparty_id, organization_id, project_id)
        REFERENCES counterparties(id, organization_id, project_id)
        ON DELETE RESTRICT,
    FOREIGN KEY (counterparty_account_id, counterparty_id, organization_id, project_id)
        REFERENCES counterparty_accounts(id, counterparty_id, organization_id, project_id)
        ON DELETE RESTRICT,
    CONSTRAINT payment_transfer_recipients_status_check CHECK (
        status IN ('pending', 'processing', 'confirmed', 'failed', 'archived')
    )
);

CREATE INDEX IF NOT EXISTS idx_payment_transfer_recipients_batch_created
    ON payment_transfer_recipients(batch_id, created_at ASC)
    WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_payment_transfer_recipients_transfer
    ON payment_transfer_recipients(transfer_id)
    WHERE transfer_id IS NOT NULL AND status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_payment_transfer_recipients_counterparty_created
    ON payment_transfer_recipients(counterparty_id, created_at DESC)
    WHERE status <> 'archived';

CREATE INDEX IF NOT EXISTS idx_payment_transfer_recipients_external_id
    ON payment_transfer_recipients(batch_id, external_id)
    WHERE external_id IS NOT NULL AND status <> 'archived';
