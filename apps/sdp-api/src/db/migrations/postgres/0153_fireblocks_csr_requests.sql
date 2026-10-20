-- Private RSA material exists here only during CSR onboarding. Once copied
-- into the credential lifecycle's secret store it is erased from this row.
CREATE TABLE fireblocks_csr_requests (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    csr_pem TEXT NOT NULL,
    encrypted_private_key TEXT,
    claim_fingerprint TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    expires_at TEXT NOT NULL,
    consumed_at TEXT,
    UNIQUE (organization_id, project_id, idempotency_key),
    CHECK (consumed_at IS NULL OR encrypted_private_key IS NULL)
);
CREATE INDEX idx_fireblocks_csr_pending
    ON fireblocks_csr_requests (organization_id, project_id, created_at DESC)
    WHERE encrypted_private_key IS NOT NULL;
CREATE INDEX idx_fireblocks_csr_expiry ON fireblocks_csr_requests (expires_at)
    WHERE encrypted_private_key IS NOT NULL;
ALTER TABLE fireblocks_csr_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE fireblocks_csr_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON fireblocks_csr_requests
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));
