-- Database-enforced tenant isolation (SDP-005 residual risk).
--
-- Every tenant-owned table gets forced row-level security keyed off three
-- transaction-local settings stamped by the application's database client
-- (apps/sdp-api/src/db/identity.ts):
--   app.tenant_isolation_identity        'tenant' | 'system' | 'operator'
--   app.tenant_isolation_organization_id the tenant's organization id
--   app.tenant_isolation_actor           system component / operator actor
--
-- Identity semantics:
--   tenant    an authenticated request pinned to one organization; reads and
--             writes outside that organization are denied.
--   system    a named platform workload (cron, webhook processor, auth
--             middleware, public endpoint) with explicit cross-tenant access.
--   operator  the audited break-glass path (src/db/operator-access.ts) —
--             granted only after the bypass is written to the audit ledger.
--   (unset)   fail closed: reads see no rows, writes are rejected.
--
-- FORCE ROW LEVEL SECURITY binds the table owner too. Like the audit-ledger
-- protections from 0047, none of this constrains SUPERUSER or BYPASSRLS
-- roles: production runtimes must connect as a plain role
-- (docs/ops/audit-ledger.md), and the test harness connects through one so
-- these policies are actually exercised.
--
-- Coverage is ratcheted by src/db/migrations/tenant-isolation-coverage.test.ts:
-- a new table must either receive a policy here (or in a later migration) or
-- be explicitly registered there as a shared/global table.

CREATE OR REPLACE FUNCTION sdp_tenant_isolation_identity()
RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(current_setting('app.tenant_isolation_identity', true), '')
$$;

CREATE OR REPLACE FUNCTION sdp_tenant_isolation_is_privileged()
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT sdp_tenant_isolation_identity() IN ('system', 'operator')
$$;

CREATE OR REPLACE FUNCTION sdp_tenant_isolation_organization_id()
RETURNS TEXT
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_isolation_organization_id', true), '')
$$;

-- The uniform predicate: privileged identities pass, a tenant identity must
-- match the row's organization. NULL organizations (e.g. pre-auth magic
-- links) are visible only to privileged identities.
CREATE OR REPLACE FUNCTION sdp_tenant_isolation_allows(row_organization_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE AS $$
  SELECT sdp_tenant_isolation_is_privileged()
      OR (
        sdp_tenant_isolation_identity() = 'tenant'
        AND row_organization_id IS NOT NULL
        AND row_organization_id = sdp_tenant_isolation_organization_id()
      )
$$;

-- ---------------------------------------------------------------------------
-- Tables carrying organization_id directly.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  tenant_table TEXT;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY[
    'projects',
    'organization_members',
    'invitations',
    'sessions',
    'magic_links',
    'issuance_transactions',
    'signing_requests',
    'auth_organization_identities',
    'notifications',
    'workflow_action_secret_retirements',
    'api_keys',
    'issued_tokens',
    'custody_configs',
    'payment_transfers',
    'custody_scope_defaults',
    'counterparties',
    'counterparty_accounts',
    'payment_subscription_plans',
    'payment_subscriptions',
    'payment_subscription_collection_attempts',
    'payment_recurring_payments',
    'wallet_control_profiles',
    'api_key_control_profiles',
    'wallet_operations',
    'approval_groups',
    'approval_requests',
    'payment_requests',
    'payment_recurring_payment_activation_attempts',
    'payment_recurring_payment_lifecycle_attempts',
    'payment_transfer_batches',
    'payment_transfer_recipients',
    'asset_profiles',
    'payment_recurring_payment_update_attempts',
    'payment_recurring_payment_update_events',
    'provider_credentials',
    'custody_connections',
    'private_channel_instances',
    'private_channels',
    'private_channel_users',
    'private_channel_events',
    'private_channel_deposits',
    'private_channel_withdrawals',
    'private_channel_transfers',
    'private_channel_verified_wallets',
    'kyc_wallets',
    'wallet_asset_enrollments',
    'asset_workflows',
    'earn_provider_wallets',
    'workflow_executions',
    'sponsorship_budget_reservations',
    'earn_program_withdrawals',
    'earn_vault_positions',
    'earn_vault_movements',
    'rpc_connections'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tenant_table);
    EXECUTE format('DROP POLICY IF EXISTS sdp_tenant_isolation ON %I', tenant_table);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation ON %1$I'
      || ' USING (sdp_tenant_isolation_allows(organization_id))'
      || ' WITH CHECK (sdp_tenant_isolation_allows(organization_id))',
      tenant_table
    );
  END LOOP;
END $$;

-- The tenant root: the organization row itself is the tenant record.
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON organizations;
CREATE POLICY sdp_tenant_isolation ON organizations
  USING (sdp_tenant_isolation_allows(id))
  WITH CHECK (sdp_tenant_isolation_allows(id));

-- ---------------------------------------------------------------------------
-- Tables whose tenant is reachable only through a parent row. The EXISTS
-- delegates to the parent's own policy, so the child is exactly as visible as
-- its parent; the privileged short-circuit keeps system paths from paying the
-- subquery. All parent foreign keys are NOT NULL ON DELETE CASCADE (or
-- covered by a CHECK, handled below), so privileged identities never lose
-- rows to a missing parent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  entry TEXT[];
BEGIN
  FOREACH entry SLICE 1 IN ARRAY ARRAY[
    ARRAY['project_members', 'projects', 'project_id'],
    ARRAY['issued_token_extensions', 'issued_tokens', 'token_id'],
    ARRAY['issuance_transaction_statuses', 'issuance_transactions', 'transaction_id'],
    ARRAY['token_allowlists', 'issued_tokens', 'token_id'],
    ARRAY['token_allowlist_statuses', 'token_allowlists', 'allowlist_id'],
    ARRAY['frozen_accounts', 'issued_tokens', 'token_id'],
    ARRAY['custody_wallets', 'custody_configs', 'custody_config_id'],
    ARRAY['api_key_wallet_permissions', 'api_keys', 'api_key_id'],
    ARRAY['wallet_control_profile_revisions', 'wallet_control_profiles', 'profile_id'],
    ARRAY['api_key_control_profile_revisions', 'api_key_control_profiles', 'profile_id'],
    ARRAY['api_key_wallet_policy_bindings', 'api_keys', 'api_key_id'],
    ARRAY['approval_group_members', 'approval_groups', 'approval_group_id'],
    ARRAY['policy_evaluations', 'wallet_operations', 'wallet_operation_id'],
    ARRAY['private_channel_memberships', 'private_channels', 'channel_id']
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', entry[1]);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', entry[1]);
    EXECUTE format('DROP POLICY IF EXISTS sdp_tenant_isolation ON %I', entry[1]);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation ON %1$I'
      || ' USING (sdp_tenant_isolation_is_privileged() OR EXISTS ('
      || '   SELECT 1 FROM %2$I parent WHERE parent.id = %1$I.%3$I))'
      || ' WITH CHECK (sdp_tenant_isolation_is_privileged() OR EXISTS ('
      || '   SELECT 1 FROM %2$I parent WHERE parent.id = %1$I.%3$I))',
      entry[1], entry[2], entry[3]
    );
  END LOOP;
END $$;

-- Two alternative parents (a CHECK guarantees at least one is set).
ALTER TABLE policy_provider_sync_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_provider_sync_status FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON policy_provider_sync_status;
CREATE POLICY sdp_tenant_isolation ON policy_provider_sync_status
  USING (
    sdp_tenant_isolation_is_privileged()
    OR EXISTS (
      SELECT 1 FROM wallet_control_profile_revisions parent
      WHERE parent.id = policy_provider_sync_status.wallet_control_profile_revision_id
    )
    OR EXISTS (
      SELECT 1 FROM api_key_control_profile_revisions parent
      WHERE parent.id = policy_provider_sync_status.api_key_control_profile_revision_id
    )
  )
  WITH CHECK (
    sdp_tenant_isolation_is_privileged()
    OR EXISTS (
      SELECT 1 FROM wallet_control_profile_revisions parent
      WHERE parent.id = policy_provider_sync_status.wallet_control_profile_revision_id
    )
    OR EXISTS (
      SELECT 1 FROM api_key_control_profile_revisions parent
      WHERE parent.id = policy_provider_sync_status.api_key_control_profile_revision_id
    )
  );

-- ---------------------------------------------------------------------------
-- Operator-owned sponsorship budget policies: polymorphic scope
-- ('global' | 'organization' | 'project'). Tenants read the policies that can
-- apply to them (admission checks run in the request path); only privileged
-- identities write. DELETE gets its own policy because a permissive ALL
-- policy's USING would let a tenant delete a global row it can read.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  scoped_table TEXT;
BEGIN
  FOREACH scoped_table IN ARRAY ARRAY[
    'sponsorship_budget_policies',
    'sponsorship_budget_policy_revisions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', scoped_table);
    EXECUTE format('DROP POLICY IF EXISTS sdp_tenant_isolation_select ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_select ON %I FOR SELECT USING ('
      || ' sdp_tenant_isolation_is_privileged()'
      || ' OR ('
      || '   sdp_tenant_isolation_identity() = ''tenant'''
      || '   AND ('
      || '     scope_type = ''global'''
      || '     OR (scope_type = ''organization'' AND scope_id = sdp_tenant_isolation_organization_id())'
      || '     OR (scope_type = ''project'' AND scope_id IN (SELECT id FROM projects))'
      || '   )'
      || ' ))',
      scoped_table
    );
    EXECUTE format('DROP POLICY IF EXISTS sdp_tenant_isolation_insert ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_insert ON %I FOR INSERT'
      || ' WITH CHECK (sdp_tenant_isolation_is_privileged())',
      scoped_table
    );
    EXECUTE format('DROP POLICY IF EXISTS sdp_tenant_isolation_update ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_update ON %I FOR UPDATE'
      || ' USING (sdp_tenant_isolation_is_privileged())'
      || ' WITH CHECK (sdp_tenant_isolation_is_privileged())',
      scoped_table
    );
    EXECUTE format('DROP POLICY IF EXISTS sdp_tenant_isolation_delete ON %I', scoped_table);
    EXECUTE format(
      'CREATE POLICY sdp_tenant_isolation_delete ON %I FOR DELETE'
      || ' USING (sdp_tenant_isolation_is_privileged())',
      scoped_table
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- audit_logs already has forced RLS from 0047 as an append-only ledger.
-- SELECT stays USING (true): the hash-chain trigger must read the previous
-- ledger row regardless of which identity performs the insert, and tightening
-- it would fork the chain. Tighten INSERT so a tenant identity can only
-- append rows attributed to its own organization.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS audit_logs_insert ON audit_logs;
CREATE POLICY audit_logs_insert ON audit_logs FOR INSERT WITH CHECK (
  sdp_tenant_isolation_is_privileged()
  OR (
    sdp_tenant_isolation_identity() = 'tenant'
    AND organization_id = sdp_tenant_isolation_organization_id()
  )
);

-- Deliberately left without tenant policies (shared/global/operator tables):
--   users, auth_user_identities        global identity; tenancy lives in
--                                      organization_members / project_members
--   allowlist                          platform-operator allowlist
--   earn_strategies                    shared yield catalog (environment-keyed)
--   audit_ledger_anchors               integrity evidence (policies from 0047)
--   counterparty_pii_migration_state   singleton migration phase flag
--   sponsorship_reconciliation_state   singleton per-network counter
--   private_channel_settlement_observations  on-chain oracle observations
--   schema_migrations                  migration bookkeeping
-- The coverage ratchet test keeps this list in sync.
