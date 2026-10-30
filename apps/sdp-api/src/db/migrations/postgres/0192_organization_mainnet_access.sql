-- An organization's one-time request for mainnet (HOO-2427): the jurisdiction it declares, the
-- SDP Terms and Conditions version an admin accepted, and when the SDP alias was told. Approval
-- stays the `enableProductionProject` entitlement an operator sets in Clerk; this row never
-- grants anything. One row per organization, written once by an admin and afterwards only by
-- the operator script (`pnpm -C apps/sdp-api mainnet-access`).
CREATE TABLE organization_mainnet_access (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    country_code TEXT NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    terms_version TEXT NOT NULL,
    terms_accepted_at TEXT NOT NULL,
    terms_accepted_by_user_id TEXT NOT NULL REFERENCES users(id),
    requested_at TEXT NOT NULL,
    requested_by_user_id TEXT NOT NULL REFERENCES users(id),
    -- Set once the SDP alias accepted the email; a request without it is resent on retry.
    notified_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now()
);
ALTER TABLE organization_mainnet_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_mainnet_access FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON organization_mainnet_access
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));
