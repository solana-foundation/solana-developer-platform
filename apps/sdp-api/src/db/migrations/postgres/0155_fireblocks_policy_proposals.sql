CREATE TABLE fireblocks_policy_proposals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  connection_id TEXT NOT NULL REFERENCES custody_connections(id),
  account_fingerprint TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  active_revision TEXT NOT NULL,
  selection_key TEXT NOT NULL,
  form JSONB NOT NULL,
  draft_id TEXT,
  draft_revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('preparing','draft','invalid','submitting','submitted','unknown','failed')),
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  UNIQUE (connection_id, request_id)
);
-- One pending policy edit per credential, across its project connections.
CREATE UNIQUE INDEX fireblocks_policy_open_proposal ON fireblocks_policy_proposals (organization_id, account_fingerprint)
  WHERE state IN ('preparing','draft','invalid','submitting','unknown');
ALTER TABLE fireblocks_policy_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE fireblocks_policy_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON fireblocks_policy_proposals
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
