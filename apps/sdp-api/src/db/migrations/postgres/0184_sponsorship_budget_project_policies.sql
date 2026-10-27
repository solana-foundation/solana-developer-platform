-- sdp:migration-compat: breaking
-- Sponsorship budgets become two tables: one network cap per network
-- (sponsorship_budget_policies, the global row and the breaker) and one cap per
-- project (sponsorship_budget_project_policies). A project is one organization's
-- one environment, so its row is the per-tenant cap; the organization scope and
-- the NULL project default are gone. Every project has exactly one row: a
-- trigger on projects writes it, at the starting limits below, in the same
-- transaction that creates the project.
--
-- Breaking: an API revision that reads scope_type or scope_id fails its budget
-- queries. Deploy only with the API that reads these tables, and never roll back
-- past it.

-- Lamport amounts the budget holds as JS numbers and as Redis Lua doubles:
-- exact only up to 2^53 - 1, unlike Solana's u64 counters (sdp_u64).
CREATE DOMAIN sdp_lua_safe_lamports AS BIGINT
  CHECK (VALUE BETWEEN 0 AND 9007199254740991);

CREATE TABLE sponsorship_budget_project_policies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL,
  per_transaction_lamports sdp_lua_safe_lamports NOT NULL,
  hourly_lamports sdp_lua_safe_lamports NOT NULL,
  daily_lamports sdp_lua_safe_lamports NOT NULL,
  version BIGINT NOT NULL,
  updated_by TEXT NOT NULL,
  update_reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  CHECK (hourly_lamports >= per_transaction_lamports),
  CHECK (daily_lamports >= hourly_lamports)
);

-- History outlives its policy: no foreign key, so a project's hard delete
-- (tests only; production soft-deletes) cascades to its policy and leaves the
-- append-only revisions in place.
CREATE TABLE sponsorship_budget_project_policy_revisions (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  per_transaction_lamports sdp_lua_safe_lamports NOT NULL,
  hourly_lamports sdp_lua_safe_lamports NOT NULL,
  daily_lamports sdp_lua_safe_lamports NOT NULL,
  version BIGINT NOT NULL,
  changed_by TEXT NOT NULL,
  change_reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  UNIQUE (policy_id, version)
);

CREATE TRIGGER sponsorship_budget_project_revisions_append_only
  BEFORE UPDATE OR DELETE ON sponsorship_budget_project_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION deny_sponsorship_budget_revision_mutation();

-- Carry every project's effective cap over: its exact override where one
-- exists, else the project default of its environment's network.
INSERT INTO sponsorship_budget_project_policies (
  id, project_id, enabled, per_transaction_lamports, hourly_lamports, daily_lamports,
  version, updated_by, update_reason
)
SELECT
  'sbpp_' || gen_random_uuid(),
  p.id,
  COALESCE(override.enabled, project_default.enabled),
  COALESCE(override.per_transaction_lamports, project_default.per_transaction_lamports),
  COALESCE(override.hourly_lamports, project_default.hourly_lamports),
  COALESCE(override.daily_lamports, project_default.daily_lamports),
  1,
  'migration',
  CASE WHEN override.id IS NULL
    THEN 'Carried over from the project default'
    ELSE 'Carried over from the project override'
  END
FROM projects p
JOIN sponsorship_budget_policies project_default
  ON project_default.scope_type = 'project'
 AND project_default.scope_id IS NULL
 AND project_default.network = CASE p.environment
       WHEN 'production' THEN 'mainnet'
       WHEN 'sandbox' THEN 'devnet'
     END
LEFT JOIN sponsorship_budget_policies override
  ON override.scope_type = 'project'
 AND override.scope_id = p.id
 AND override.network = project_default.network;

INSERT INTO sponsorship_budget_project_policy_revisions (
  id, policy_id, project_id, enabled, per_transaction_lamports, hourly_lamports,
  daily_lamports, version, changed_by, change_reason
)
SELECT
  'sbppr_' || id || '_1', id, project_id, enabled, per_transaction_lamports, hourly_lamports,
  daily_lamports, version, updated_by, update_reason
FROM sponsorship_budget_project_policies;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM projects p
    WHERE NOT EXISTS (
      SELECT 1 FROM sponsorship_budget_project_policies pp WHERE pp.project_id = p.id
    )
  ) THEN
    RAISE EXCEPTION 'a project has no sponsorship budget policy';
  END IF;
END $$;

-- Starting limits for a new project, per environment. Raising or lowering one
-- project afterwards is an operator change (pnpm sponsorship:budget set-project);
-- changing what new projects start with is a migration.
CREATE OR REPLACE FUNCTION sdp_sponsorship_budget_project_policy_for_new_project()
RETURNS trigger AS $$
DECLARE
  new_policy_id TEXT := 'sbpp_' || gen_random_uuid();
BEGIN
  INSERT INTO sponsorship_budget_project_policies (
    id, project_id, enabled, per_transaction_lamports, hourly_lamports, daily_lamports,
    version, updated_by, update_reason
  ) VALUES (
    new_policy_id,
    NEW.id,
    TRUE,
    10000000,
    CASE NEW.environment WHEN 'production' THEN 100000000 WHEN 'sandbox' THEN 1000000000 END,
    CASE NEW.environment WHEN 'production' THEN 250000000 WHEN 'sandbox' THEN 3000000000 END,
    1,
    'system:project-created',
    'Starting limits for a new project'
  );
  INSERT INTO sponsorship_budget_project_policy_revisions (
    id, policy_id, project_id, enabled, per_transaction_lamports, hourly_lamports,
    daily_lamports, version, changed_by, change_reason
  )
  SELECT
    'sbppr_' || id || '_1', id, project_id, enabled, per_transaction_lamports, hourly_lamports,
    daily_lamports, version, updated_by, update_reason
  FROM sponsorship_budget_project_policies
  WHERE id = new_policy_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER sponsorship_budget_project_policy_for_new_project
  AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION sdp_sponsorship_budget_project_policy_for_new_project();

-- Tenants read their own projects' caps (the projects policy scopes the
-- subquery); only privileged identities write, except the insert the project
-- trigger makes inside the tenant's own project-creating transaction.
DO $$
DECLARE
  scoped_table TEXT;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY[
    'sponsorship_budget_project_policies',
    'sponsorship_budget_project_policy_revisions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_select ON %I FOR SELECT USING ('
      || ' sdp_tenant_isolation_is_privileged()'
      || ' OR (sdp_tenant_isolation_identity() = ''tenant'''
      || '     AND project_id IN (SELECT id FROM projects))'
      || ')',
      scoped_table
    );
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_insert ON %I FOR INSERT'
      || ' WITH CHECK (sdp_tenant_isolation_is_privileged() OR pg_trigger_depth() > 0)',
      scoped_table
    );
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_update ON %I FOR UPDATE'
      || ' USING (sdp_tenant_isolation_is_privileged())'
      || ' WITH CHECK (sdp_tenant_isolation_is_privileged())',
      scoped_table
    );
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_delete ON %I FOR DELETE'
      || ' USING (sdp_tenant_isolation_is_privileged())',
      scoped_table
    );
  END LOOP;
END $$;

-- The old table keeps only the network rows. Its revisions are append-only, so
-- the trigger is suspended inside this transaction while the organization and
-- project history goes; the project history now lives in the new table.
ALTER TABLE sponsorship_budget_policy_revisions
  DISABLE TRIGGER sponsorship_budget_revisions_append_only;
DELETE FROM sponsorship_budget_policy_revisions WHERE scope_type <> 'global';
DELETE FROM sponsorship_budget_policies WHERE scope_type <> 'global';
ALTER TABLE sponsorship_budget_policy_revisions
  ENABLE TRIGGER sponsorship_budget_revisions_append_only;

DO $$
DECLARE
  scoped_table TEXT;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY[
    'sponsorship_budget_policies',
    'sponsorship_budget_policy_revisions'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS sdp_tenant_isolation_select ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_select ON %I FOR SELECT USING ('
      || ' sdp_tenant_isolation_is_privileged()'
      || ' OR sdp_tenant_isolation_identity() = ''tenant'''
      || ')',
      scoped_table
    );
  END LOOP;
END $$;

DROP INDEX idx_sponsorship_budget_policy_scope;
ALTER TABLE sponsorship_budget_policies DROP COLUMN scope_type, DROP COLUMN scope_id;
ALTER TABLE sponsorship_budget_policy_revisions DROP COLUMN scope_type, DROP COLUMN scope_id;

-- Budgets key on the SDP environment rather than a network name: sandbox
-- projects draw on devnet and production projects on mainnet, and the
-- environment is what every request and job already carries. The global table
-- holds exactly one row per environment, keyed by it.
ALTER TABLE sponsorship_budget_policy_revisions
  DISABLE TRIGGER sponsorship_budget_revisions_append_only;

ALTER TABLE sponsorship_budget_policy_revisions
  DROP CONSTRAINT sponsorship_budget_policy_revisions_policy_id_fkey,
  DROP CONSTRAINT sponsorship_budget_policy_revisions_policy_id_version_key;
DROP INDEX idx_sponsorship_budget_policy_revisions_policy;
ALTER TABLE sponsorship_budget_policy_revisions RENAME COLUMN network TO environment;
UPDATE sponsorship_budget_policy_revisions SET environment = CASE environment
  WHEN 'mainnet' THEN 'production'
  WHEN 'devnet' THEN 'sandbox'
END;
ALTER TABLE sponsorship_budget_policy_revisions DROP COLUMN policy_id;

ALTER TABLE sponsorship_budget_policies
  DROP CONSTRAINT sponsorship_budget_policies_network_check,
  DROP CONSTRAINT sponsorship_budget_policies_pkey;
ALTER TABLE sponsorship_budget_policies DROP COLUMN id;
ALTER TABLE sponsorship_budget_policies RENAME COLUMN network TO environment;
UPDATE sponsorship_budget_policies SET environment = CASE environment
  WHEN 'mainnet' THEN 'production'
  WHEN 'devnet' THEN 'sandbox'
END;
ALTER TABLE sponsorship_budget_policies
  ADD CONSTRAINT sponsorship_budget_policies_environment_check
    CHECK (environment IN ('sandbox', 'production')),
  ADD PRIMARY KEY (environment);

ALTER TABLE sponsorship_budget_policy_revisions
  ADD CONSTRAINT sponsorship_budget_policy_revisions_environment_fkey
    FOREIGN KEY (environment) REFERENCES sponsorship_budget_policies(environment) ON DELETE RESTRICT,
  ADD CONSTRAINT sponsorship_budget_policy_revisions_environment_version_key
    UNIQUE (environment, version);

ALTER TABLE sponsorship_budget_policy_revisions
  ENABLE TRIGGER sponsorship_budget_revisions_append_only;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sponsorship_budget_reservations
    WHERE product_environment <> CASE network WHEN 'mainnet' THEN 'production' WHEN 'devnet' THEN 'sandbox' END
  ) THEN
    RAISE EXCEPTION 'a sponsorship reservation network disagrees with its environment';
  END IF;
END $$;

DROP INDEX idx_sponsorship_budget_reservations_hour;
DROP INDEX idx_sponsorship_budget_reservations_day;
ALTER TABLE sponsorship_budget_reservations DROP COLUMN network;
ALTER TABLE sponsorship_budget_reservations RENAME COLUMN product_environment TO environment;
ALTER TABLE sponsorship_budget_reservations
  RENAME CONSTRAINT sponsorship_budget_reservations_product_environment_check
  TO sponsorship_budget_reservations_environment_check;
CREATE INDEX idx_sponsorship_budget_reservations_hour
  ON sponsorship_budget_reservations (environment, hour_bucket);
CREATE INDEX idx_sponsorship_budget_reservations_day
  ON sponsorship_budget_reservations (environment, day_bucket);

ALTER TABLE sponsorship_reconciliation_state
  DROP CONSTRAINT sponsorship_reconciliation_state_network_check;
ALTER TABLE sponsorship_reconciliation_state RENAME COLUMN network TO environment;
UPDATE sponsorship_reconciliation_state SET environment = CASE environment
  WHEN 'mainnet' THEN 'production'
  WHEN 'devnet' THEN 'sandbox'
END;
ALTER TABLE sponsorship_reconciliation_state
  ADD CONSTRAINT sponsorship_reconciliation_state_environment_check
    CHECK (environment IN ('sandbox', 'production'));
