-- Expand-only. No applicant answers, SSNs, CDD or file contents are stored.
CREATE TABLE earn_onboarding_customers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  counterparty_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('individual', 'business')),
  moderator_guid TEXT NOT NULL,
  organization_guid TEXT,
  person_guid TEXT,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'linked', 'archived')),
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  UNIQUE (organization_id, project_id, environment, counterparty_id),
  UNIQUE (environment, organization_guid),
  UNIQUE (environment, person_guid),
  CHECK (organization_guid IS NULL OR organization_guid <> moderator_guid),
  CHECK ((entity_type = 'business' AND person_guid IS NULL) OR
         (entity_type = 'individual' AND organization_guid IS NULL)),
  CHECK (status <> 'linked' OR organization_guid IS NOT NULL OR person_guid IS NOT NULL)
);
CREATE TABLE earn_onboarding_documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  counterparty_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  encrypted_reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT sdp_iso_now()
);
CREATE INDEX earn_onboarding_documents_customer_idx ON earn_onboarding_documents
  (organization_id, project_id, environment, counterparty_id);

CREATE TABLE earn_onboarding_wallets (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  counterparty_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
  owner_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'linked', 'archived')),
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  PRIMARY KEY (environment, owner_address)
);
ALTER TABLE earn_onboarding_customers ADD CONSTRAINT earn_onboarding_customer_parent_fk
  FOREIGN KEY (counterparty_id, organization_id, project_id) REFERENCES counterparties(id, organization_id, project_id) NOT VALID;
ALTER TABLE earn_onboarding_documents ADD CONSTRAINT earn_onboarding_document_parent_fk
  FOREIGN KEY (counterparty_id, organization_id, project_id) REFERENCES counterparties(id, organization_id, project_id) NOT VALID;
ALTER TABLE earn_onboarding_wallets ADD CONSTRAINT earn_onboarding_wallet_parent_fk
  FOREIGN KEY (counterparty_id, organization_id, project_id) REFERENCES counterparties(id, organization_id, project_id) NOT VALID;

ALTER TABLE earn_onboarding_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_onboarding_customers FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_onboarding_customers
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE earn_onboarding_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_onboarding_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_onboarding_documents
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));

ALTER TABLE earn_onboarding_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_onboarding_wallets FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_onboarding_wallets
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
