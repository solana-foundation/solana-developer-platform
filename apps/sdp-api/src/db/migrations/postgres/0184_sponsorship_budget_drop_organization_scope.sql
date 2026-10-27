-- sdp:migration-compat: breaking
-- Sponsorship budgets resolve from the global and project scopes only: a
-- project is one organization's one environment, so the project row is the
-- per-tenant cap and the organization scope is gone.
--
-- Breaking: an API revision that still resolves the organization scope finds
-- no organization row, treats the hierarchy as incomplete and trips the
-- network breaker. Deploy only once the two-scope API is the live revision in
-- every environment, and never roll back past it.
--
-- The append-only revisions trigger is suspended inside this transaction so the
-- organization rows' history goes with them; nothing reads it once the scope is
-- gone.

ALTER TABLE sponsorship_budget_policy_revisions
  DISABLE TRIGGER sponsorship_budget_revisions_append_only;

DELETE FROM sponsorship_budget_policy_revisions WHERE scope_type = 'organization';
DELETE FROM sponsorship_budget_policies WHERE scope_type = 'organization';

ALTER TABLE sponsorship_budget_policy_revisions
  ENABLE TRIGGER sponsorship_budget_revisions_append_only;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM sponsorship_budget_policies WHERE scope_type = 'organization')
     OR EXISTS (SELECT 1 FROM sponsorship_budget_policy_revisions WHERE scope_type = 'organization')
  THEN
    RAISE EXCEPTION 'organization-scope sponsorship budget rows remain';
  END IF;
END $$;

ALTER TABLE sponsorship_budget_policies
  DROP CONSTRAINT sponsorship_budget_policies_scope_type_check;
ALTER TABLE sponsorship_budget_policies
  ADD CONSTRAINT sponsorship_budget_policies_scope_type_check
  CHECK (scope_type IN ('global', 'project'));

-- NULL-scoped project rows are the platform-wide default every tenant's
-- admission check resolves against; they carry no tenant data, so every tenant
-- may read them.
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
      || ' OR ('
      || '   sdp_tenant_isolation_identity() = ''tenant'''
      || '   AND ('
      || '     scope_type = ''global'''
      || '     OR (scope_type = ''project'''
      || '         AND (scope_id IN (SELECT id FROM projects) OR scope_id IS NULL))'
      || '   )'
      || ' ))',
      scoped_table
    );
  END LOOP;
END $$;
