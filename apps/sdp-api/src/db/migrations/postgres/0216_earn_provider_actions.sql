-- Preparation and cancellation transactions are durable commands, not deposits or payouts.
CREATE TABLE earn_provider_actions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('sandbox','production')),
  provider TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('preparation','cancellation')),
  status TEXT NOT NULL CHECK (status IN ('preparing','not_required','prepared','requested','submitted','confirmed','awaiting_delivery','finalized','failed')),
  parent_movement_id TEXT,
  custody_wallet_id TEXT,
  owner_address TEXT NOT NULL,
  vault_address TEXT NOT NULL,
  token_mint TEXT NOT NULL,
  share_mint TEXT NOT NULL,
  fee_payer TEXT,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  unsigned_transaction TEXT,
  signed_transaction TEXT,
  signature TEXT,
  last_valid_block_height NUMERIC(20,0),
  delivery_signature TEXT,
  error TEXT,
  unknown_signature_observed_at TEXT,
  lease_until TEXT NOT NULL,
  next_check_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  created_by TEXT,
  initiated_by_key_id TEXT,
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  UNIQUE (organization_id,project_id,request_id),
  CHECK ((action='preparation' AND parent_movement_id IS NULL) OR (action='cancellation' AND parent_movement_id IS NOT NULL)),
  CHECK (status NOT IN ('requested','submitted','confirmed','awaiting_delivery','finalized') OR (signed_transaction IS NOT NULL AND signature IS NOT NULL AND last_valid_block_height IS NOT NULL))
);
CREATE UNIQUE INDEX earn_provider_actions_signature ON earn_provider_actions(environment,signature) WHERE signature IS NOT NULL;
CREATE INDEX earn_provider_actions_due ON earn_provider_actions(environment,next_check_at) WHERE status IN ('requested','submitted','confirmed','awaiting_delivery');
CREATE UNIQUE INDEX earn_provider_actions_one_cancellation ON earn_provider_actions(parent_movement_id)
  WHERE action='cancellation' AND status NOT IN ('failed','prepared');
ALTER TABLE earn_provider_actions ADD CONSTRAINT earn_provider_actions_org_fk FOREIGN KEY (organization_id) REFERENCES organizations(id) NOT VALID;
ALTER TABLE earn_provider_actions ADD CONSTRAINT earn_provider_actions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) NOT VALID;
ALTER TABLE earn_provider_actions ADD CONSTRAINT earn_provider_actions_parent_fk FOREIGN KEY (parent_movement_id) REFERENCES earn_movements(id) NOT VALID;
ALTER TABLE earn_provider_actions ADD CONSTRAINT earn_provider_actions_wallet_fk FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) NOT VALID;
ALTER TABLE earn_provider_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE earn_provider_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON earn_provider_actions
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
