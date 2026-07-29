-- A verified wallet cleared to hold a specific asset. Keyed on token_id — the stable
-- identity the allowlist, workflows, and on-chain layers all reference (an asset
-- profile is mutable/archivable, so it's a worse anchor). In v1 the existence of an
-- active row IS the eligibility clearance. See Phase 5 plan.

CREATE TABLE IF NOT EXISTS wallet_asset_enrollments (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    kyc_wallet_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    review_mode TEXT NOT NULL DEFAULT 'auto',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    revoked_at TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (kyc_wallet_id) REFERENCES kyc_wallets(id) ON DELETE CASCADE,
    FOREIGN KEY (token_id) REFERENCES issued_tokens(id) ON DELETE CASCADE,
    CONSTRAINT wallet_asset_enrollments_status_check
        CHECK (status IN ('active', 'revoked')),
    CONSTRAINT wallet_asset_enrollments_review_mode_check
        CHECK (review_mode IN ('auto', 'manual')),
    UNIQUE (kyc_wallet_id, token_id)
);

-- Hot reverse-lookup: verified wallets cleared for a given asset (allowlist reconcile).
CREATE INDEX IF NOT EXISTS idx_wallet_asset_enrollments_token_status
    ON wallet_asset_enrollments(token_id, status);
