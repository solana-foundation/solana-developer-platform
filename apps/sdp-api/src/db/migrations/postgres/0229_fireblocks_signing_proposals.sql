-- Sign-only proposals are recoverable cancellation targets, never instructions to broadcast.
CREATE TABLE fireblocks_signing_proposals (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id),
    connection_id TEXT NOT NULL,
    account_fingerprint TEXT NOT NULL,
    vault_account_id TEXT NOT NULL,
    source_address TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('RAW', 'PROGRAM_CALL')),
    provider_transaction_id TEXT,
    status TEXT NOT NULL DEFAULT 'SUBMITTING',
    request_id TEXT,
    cancel_requested_at TEXT,
    finished_at TEXT,
    last_polled_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now()
);
CREATE INDEX idx_fireblocks_signing_wallet
    ON fireblocks_signing_proposals (organization_id, project_id, custody_wallet_id, created_at DESC, id DESC);
ALTER TABLE fireblocks_signing_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fireblocks_signing_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON fireblocks_signing_proposals
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));
