-- Counterparty accounts: reusable recipient/payment identifiers attached to a
-- counterparty. Following Polar's payout account pattern, raw provider-owned
-- financial credentials should live with the provider when possible; SDP stores
-- non-secret recipient identifiers and durable provider refs/sanitized metadata.
--
-- Also extends counterparties with provider_data: counterparty-level provider
-- handles (e.g. Grid customerId) that are 1:1 with the identity and shared
-- across all of its accounts. Account-specific provider handles live in
-- counterparty_accounts.provider_account_data.
--
-- account_kind is intentionally left as open TEXT (no CHECK constraint) so new
-- payout rails can be added without a migration. Current allowed values are
-- enforced at the application layer via COUNTERPARTY_ACCOUNT_KINDS in
-- @sdp/types: 'bank_account' | 'crypto_wallet'.

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'counterparties_id_org_project_key'
    ) THEN
        ALTER TABLE counterparties ADD CONSTRAINT counterparties_id_org_project_key
            UNIQUE (id, organization_id, project_id);
    END IF;
END $$;

ALTER TABLE counterparties
    ADD COLUMN IF NOT EXISTS provider_data JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'counterparties_provider_data_is_object'
    ) THEN
        ALTER TABLE counterparties
            ADD CONSTRAINT counterparties_provider_data_is_object
            CHECK (jsonb_typeof(provider_data) = 'object');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS counterparty_accounts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    counterparty_id TEXT NOT NULL,
    account_kind TEXT NOT NULL,
    label TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider_account_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (counterparty_id, organization_id, project_id)
        REFERENCES counterparties(id, organization_id, project_id)
        ON DELETE CASCADE,
    CONSTRAINT counterparty_accounts_details_is_object CHECK (jsonb_typeof(details) = 'object'),
    CONSTRAINT counterparty_accounts_provider_account_data_is_object CHECK (jsonb_typeof(provider_account_data) = 'object'),
    CONSTRAINT counterparty_accounts_status_check CHECK (status IN ('active', 'archived'))
);

CREATE INDEX IF NOT EXISTS idx_counterparty_accounts_counterparty_status_created
    ON counterparty_accounts(counterparty_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_counterparty_accounts_org_project_kind_created
    ON counterparty_accounts(organization_id, project_id, account_kind, created_at DESC)
    WHERE status = 'active';
