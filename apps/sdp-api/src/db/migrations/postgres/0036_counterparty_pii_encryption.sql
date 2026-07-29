-- Additive envelope-encryption storage for counterparty PII. Legacy columns
-- remain nullable during the dual-write/backfill window so the previous
-- application revision remains rollback-compatible.

ALTER TABLE counterparties
    ADD COLUMN IF NOT EXISTS pii_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS provider_data_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS bvnk_customer_reference TEXT,
    ADD COLUMN IF NOT EXISTS mural_organization_id TEXT;

ALTER TABLE counterparties
    ALTER COLUMN email DROP NOT NULL,
    ALTER COLUMN identity DROP NOT NULL,
    ALTER COLUMN identity DROP DEFAULT,
    ALTER COLUMN provider_data DROP NOT NULL,
    ALTER COLUMN provider_data DROP DEFAULT;

ALTER TABLE counterparty_accounts
    ADD COLUMN IF NOT EXISTS sensitive_data_encrypted TEXT,
    ADD COLUMN IF NOT EXISTS network TEXT,
    ADD COLUMN IF NOT EXISTS address TEXT;

ALTER TABLE counterparty_accounts
    ALTER COLUMN details DROP NOT NULL,
    ALTER COLUMN details DROP DEFAULT,
    ALTER COLUMN provider_account_data DROP NOT NULL,
    ALTER COLUMN provider_account_data DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_counterparties_bvnk_customer_reference
    ON counterparties(bvnk_customer_reference)
    WHERE status = 'active' AND bvnk_customer_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_counterparties_mural_organization_id
    ON counterparties(mural_organization_id)
    WHERE status = 'active' AND mural_organization_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS counterparty_pii_migration_state (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    fallback_read_count BIGINT NOT NULL DEFAULT 0,
    last_fallback_read_at TEXT,
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT counterparty_pii_migration_phase_check
        CHECK (phase IN ('dual_write', 'encrypted_only'))
);

INSERT INTO counterparty_pii_migration_state (id, phase)
VALUES ('counterparty-pii-v1', 'dual_write')
ON CONFLICT (id) DO NOTHING;
