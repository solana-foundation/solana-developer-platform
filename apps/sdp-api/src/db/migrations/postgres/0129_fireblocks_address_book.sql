-- Provider metadata only. Credentials remain in provider_credentials.
CREATE TABLE fireblocks_contact_sync (
    connection_id TEXT PRIMARY KEY REFERENCES custody_connections(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    lease_id TEXT,
    lease_until TEXT,
    synced_at TEXT
);
CREATE TABLE fireblocks_contact_links (
    connection_id TEXT NOT NULL REFERENCES custody_connections(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    wallet_type TEXT NOT NULL,
    wallet_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    address TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES counterparty_accounts(id) ON DELETE CASCADE,
    managed BOOLEAN NOT NULL DEFAULT FALSE,
    imported_name TEXT NOT NULL,
    remote_status TEXT NOT NULL,
    seen_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    PRIMARY KEY (connection_id, wallet_type, wallet_id, asset_id, address)
);
CREATE TABLE fireblocks_whitelist_proposals (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES custody_connections(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    account_fingerprint TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    address TEXT NOT NULL,
    wallet_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('creating_wallet','adding_address','submitted','unknown','failed')),
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    UNIQUE (connection_id, asset_id, address)
);
ALTER TABLE fireblocks_contact_sync ENABLE ROW LEVEL SECURITY;
ALTER TABLE fireblocks_contact_sync FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON fireblocks_contact_sync USING (sdp_tenant_isolation_allows(organization_id)) WITH CHECK (sdp_tenant_isolation_allows(organization_id));
ALTER TABLE fireblocks_contact_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE fireblocks_contact_links FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON fireblocks_contact_links USING (sdp_tenant_isolation_allows(organization_id)) WITH CHECK (sdp_tenant_isolation_allows(organization_id));
ALTER TABLE fireblocks_whitelist_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fireblocks_whitelist_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON fireblocks_whitelist_proposals USING (sdp_tenant_isolation_allows(organization_id)) WITH CHECK (sdp_tenant_isolation_allows(organization_id));
