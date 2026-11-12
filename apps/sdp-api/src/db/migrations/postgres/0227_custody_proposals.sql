-- Proposals own provider progress and recovery scheduling. Payments retain the
-- original principal, public projection and audit intent throughout rollout.
CREATE TABLE custody_proposals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  custody_wallet_id TEXT,
  payment_transfer_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL CHECK (provider IN ('local','fireblocks','privy','coinbase_cdp','para','turnkey','dfns','ibm_haven','anchorage','utila')),
  binding JSONB NOT NULL CHECK (jsonb_typeof(binding) = 'object'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  provider_phase TEXT NOT NULL CHECK (provider_phase IN ('unsent','submitting','absent','pending','executing','completed','failed','cancelled','not_sent','never_accepted')),
  authorization_state TEXT NOT NULL CHECK (authorization_state IN ('authorized','refused','cancel_requested','cancel_acknowledged','committed_after_refusal')),
  provider_transaction_id TEXT,
  provider_status TEXT,
  provider_sub_status TEXT,
  submission_started_at TEXT,
  first_missing_at TEXT,
  refused_at TEXT,
  refusal_reason TEXT,
  refusal_message TEXT,
  cancel_requested_at TEXT,
  cancel_acknowledged_at TEXT,
  alerted_at TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  recheck_requested_at TEXT,
  next_check_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_polled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((refused_at IS NULL AND refusal_reason IS NULL AND refusal_message IS NULL)
      OR (refused_at IS NOT NULL AND refusal_reason IS NOT NULL AND refusal_message IS NOT NULL)),
  CHECK ((authorization_state = 'authorized') = (refused_at IS NULL)),
  CHECK (authorization_state <> 'committed_after_refusal' OR provider_phase = 'completed'),
  CHECK (alerted_at IS NULL OR authorization_state = 'committed_after_refusal'),
  CHECK (cancel_acknowledged_at IS NULL OR cancel_requested_at IS NOT NULL),
  CHECK (provider_phase <> 'completed' OR provider_transaction_id IS NOT NULL)
);
CREATE INDEX custody_proposals_due_idx ON custody_proposals (next_check_at, id)
  WHERE status = 'active' AND provider_phase IN ('unsent','submitting','absent','pending','executing');
CREATE INDEX custody_proposals_requested_idx ON custody_proposals (recheck_requested_at, id)
  WHERE status = 'active' AND recheck_requested_at IS NOT NULL
    AND provider_phase IN ('unsent','submitting','absent','pending','executing');
-- Temporary rolling-deploy lane; never scan every pending proposal for unsent rows.
CREATE INDEX custody_proposals_legacy_unsent_idx ON custody_proposals (payment_transfer_id)
  WHERE status = 'active' AND provider_phase = 'unsent' AND authorization_state = 'authorized';
CREATE INDEX custody_proposals_unalerted_idx ON custody_proposals (refused_at, id)
  WHERE status = 'active' AND authorization_state = 'committed_after_refusal' AND alerted_at IS NULL;

-- NOT VALID avoids a blocking parent-table scan while the prior revision serves.
ALTER TABLE custody_proposals ADD CONSTRAINT custody_proposals_payment_fk
  FOREIGN KEY (payment_transfer_id, organization_id, project_id)
  REFERENCES payment_transfers (id, organization_id, project_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE custody_proposals ADD CONSTRAINT custody_proposals_project_fk
  FOREIGN KEY (project_id, organization_id) REFERENCES projects (id, organization_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE custody_proposals ADD CONSTRAINT custody_proposals_wallet_fk
  FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets (id) NOT VALID;
ALTER TABLE custody_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE custody_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON custody_proposals
  USING (sdp_tenant_isolation_allows(organization_id))
  WITH CHECK (sdp_tenant_isolation_allows(organization_id));
