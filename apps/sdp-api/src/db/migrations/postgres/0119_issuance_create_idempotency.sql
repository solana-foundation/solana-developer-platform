-- Atomic idempotency records for the issuance creation routes
-- (APE-719 / SOLA9-195).
--
-- POST /v1/issuance/tokens and POST /v1/issuance/asset-profiles commit a
-- token (+ default asset profile) in one transaction and admit the audit
-- event around it. Each row here binds a caller's Idempotency-Key to the
-- generated token id and a fingerprint of the normalized request, and is
-- inserted inside the SAME transaction as the pair it describes: either both
-- commit or neither does. A retry of an admission that already committed
-- (its audit outcome was lost, or the response never reached the caller)
-- replays the original token instead of creating a second unaudited draft.
--
-- Tenant isolation is part of the creating migration. A later coverage test
-- rejects any tenant-owned table which relies on application scoping alone.
CREATE TABLE IF NOT EXISTS issuance_create_idempotency (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    token_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    CONSTRAINT issuance_create_idempotency_scope_check CHECK (
        scope IN ('token_create', 'asset_profile_create')
    ),
    -- One claim per caller key within a tenant/project/scope. The record and
    -- its token commit together, so this constraint is what stops two
    -- concurrent identical requests from both committing a pair.
    CONSTRAINT issuance_create_idempotency_key_unique
        UNIQUE (organization_id, project_id, scope, idempotency_key),
    FOREIGN KEY (token_id, organization_id, project_id)
        REFERENCES issued_tokens (id, organization_id, project_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_issuance_create_idempotency_token
    ON issuance_create_idempotency (token_id, organization_id, project_id);

ALTER TABLE issuance_create_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE issuance_create_idempotency FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON issuance_create_idempotency;
CREATE POLICY sdp_tenant_isolation ON issuance_create_idempotency
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
