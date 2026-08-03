-- Operator-owned monetary controls for managed Kora sponsorship.
-- Redis is the atomic admission layer; these tables are the durable policy,
-- audit, idempotency, and recovery source of truth.

CREATE TABLE IF NOT EXISTS sponsorship_budget_policies (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'organization', 'project')),
  scope_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  per_transaction_lamports BIGINT NOT NULL,
  hourly_lamports BIGINT NOT NULL,
  daily_lamports BIGINT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  update_reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  CHECK (scope_type <> 'global' OR scope_id IS NULL),
  CHECK (per_transaction_lamports >= 0 AND per_transaction_lamports <= 9007199254740991),
  CHECK (hourly_lamports >= per_transaction_lamports AND hourly_lamports <= 9007199254740991),
  CHECK (daily_lamports >= hourly_lamports AND daily_lamports <= 9007199254740991)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsorship_budget_policy_scope
  ON sponsorship_budget_policies (network, scope_type, COALESCE(scope_id, ''));

CREATE TABLE IF NOT EXISTS sponsorship_budget_policy_revisions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL REFERENCES sponsorship_budget_policies(id) ON DELETE RESTRICT,
  network TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id TEXT,
  enabled BOOLEAN NOT NULL,
  per_transaction_lamports BIGINT NOT NULL,
  hourly_lamports BIGINT NOT NULL,
  daily_lamports BIGINT NOT NULL,
  version BIGINT NOT NULL,
  changed_by TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  UNIQUE (policy_id, version)
);

CREATE INDEX IF NOT EXISTS idx_sponsorship_budget_policy_revisions_policy
  ON sponsorship_budget_policy_revisions (policy_id, version DESC);

CREATE OR REPLACE FUNCTION deny_sponsorship_budget_revision_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'sponsorship budget policy revisions are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS sponsorship_budget_revisions_append_only
  ON sponsorship_budget_policy_revisions;
CREATE TRIGGER sponsorship_budget_revisions_append_only
  BEFORE UPDATE OR DELETE ON sponsorship_budget_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION deny_sponsorship_budget_revision_mutation();

CREATE TABLE IF NOT EXISTS sponsorship_budget_reservations (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('devnet', 'mainnet')),
  product_environment TEXT NOT NULL CHECK (product_environment IN ('sandbox', 'production')),
  organization_id TEXT NOT NULL,
  project_id TEXT,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  transaction_digest TEXT NOT NULL,
  fee_payer TEXT NOT NULL,
  provider_config_fingerprint TEXT NOT NULL,
  recent_blockhash TEXT NOT NULL,
  reserved_lamports BIGINT NOT NULL CHECK (reserved_lamports >= 0),
  actual_lamports BIGINT CHECK (actual_lamports IS NULL OR actual_lamports >= 0),
  hour_bucket TEXT NOT NULL,
  day_bucket TEXT NOT NULL,
  policy_versions TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('reserved', 'signed', 'submitted', 'committed', 'released', 'charged_unknown')
  ),
  signature TEXT,
  signed_transaction TEXT,
  attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  miss_count INTEGER NOT NULL DEFAULT 0 CHECK (miss_count >= 0),
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  submitted_at TEXT,
  reconciled_at TEXT,
  redis_settled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sponsorship_budget_reservations_reconcile
  ON sponsorship_budget_reservations (status, updated_at)
  WHERE status IN ('reserved', 'signed', 'submitted');

CREATE INDEX IF NOT EXISTS idx_sponsorship_budget_reservations_redis_sync
  ON sponsorship_budget_reservations (redis_settled_at, updated_at)
  WHERE status IN ('committed', 'released') AND redis_settled_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_sponsorship_budget_reservations_hour
  ON sponsorship_budget_reservations (network, hour_bucket);

CREATE INDEX IF NOT EXISTS idx_sponsorship_budget_reservations_day
  ON sponsorship_budget_reservations (network, day_bucket);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sponsorship_budget_reservations_signature
  ON sponsorship_budget_reservations (signature)
  WHERE signature IS NOT NULL;

INSERT INTO sponsorship_budget_policies (
  id, network, scope_type, scope_id, enabled,
  per_transaction_lamports, hourly_lamports, daily_lamports,
  version, updated_by, update_reason
) VALUES
  ('sbp_devnet_global', 'devnet', 'global', NULL, TRUE, 10000000, 2000000000, 10000000000, 1, 'migration', 'Initial devnet sponsorship controls'),
  ('sbp_devnet_org_default', 'devnet', 'organization', NULL, TRUE, 10000000, 1000000000, 5000000000, 1, 'migration', 'Initial devnet organization default'),
  ('sbp_devnet_project_default', 'devnet', 'project', NULL, TRUE, 10000000, 1000000000, 3000000000, 1, 'migration', 'Initial devnet project default'),
  ('sbp_mainnet_global', 'mainnet', 'global', NULL, FALSE, 10000000, 500000000, 1000000000, 1, 'migration', 'Mainnet remains disabled pending operator approval'),
  ('sbp_mainnet_org_default', 'mainnet', 'organization', NULL, TRUE, 10000000, 250000000, 500000000, 1, 'migration', 'Initial mainnet organization default'),
  ('sbp_mainnet_project_default', 'mainnet', 'project', NULL, TRUE, 10000000, 100000000, 250000000, 1, 'migration', 'Initial mainnet project default')
ON CONFLICT DO NOTHING;

INSERT INTO sponsorship_budget_policy_revisions (
  id, policy_id, network, scope_type, scope_id, enabled,
  per_transaction_lamports, hourly_lamports, daily_lamports,
  version, changed_by, change_reason
)
SELECT
  'sbpr_' || id || '_1', id, network, scope_type, scope_id, enabled,
  per_transaction_lamports, hourly_lamports, daily_lamports,
  version, updated_by, update_reason
FROM sponsorship_budget_policies
WHERE id IN (
  'sbp_devnet_global', 'sbp_devnet_org_default', 'sbp_devnet_project_default',
  'sbp_mainnet_global', 'sbp_mainnet_org_default', 'sbp_mainnet_project_default'
)
ON CONFLICT DO NOTHING;
