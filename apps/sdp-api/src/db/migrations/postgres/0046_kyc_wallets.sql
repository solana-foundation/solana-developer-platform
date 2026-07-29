-- SDP-owned, provider-agnostic KYC wallet records. Identity is verified once per
-- wallet and reused across assets; KYC providers (Mural today, others later) are
-- writers into kyc_status — SDP owns the normalized status. kyc_provider/provider_ref
-- only record who verified it. See Phase 5 plan (Workflow Builder).

CREATE TABLE IF NOT EXISTS kyc_wallets (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    wallet_address TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'solana',
    -- Optional link to the person/business this wallet belongs to. Provider webhooks
    -- resolve which wallets to verify through this link.
    counterparty_id TEXT,
    kyc_status TEXT NOT NULL DEFAULT 'unverified',
    kyc_provider TEXT,
    provider_ref TEXT,
    verified_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (counterparty_id) REFERENCES counterparties(id) ON DELETE SET NULL,
    CONSTRAINT kyc_wallets_status_check
        CHECK (kyc_status IN ('unverified', 'pending', 'verified', 'rejected')),
    UNIQUE (organization_id, project_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_kyc_wallets_org_status
    ON kyc_wallets(organization_id, kyc_status);

-- Provider webhooks (e.g. Mural) resolve wallets by their linked counterparty.
CREATE INDEX IF NOT EXISTS idx_kyc_wallets_counterparty
    ON kyc_wallets(counterparty_id) WHERE counterparty_id IS NOT NULL;
