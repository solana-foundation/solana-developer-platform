-- Foundations for SDP wallet/API key policy controls.
-- This migration is intentionally storage-only: enforcement and evaluator
-- semantics are introduced by later policy tickets.

CREATE TABLE IF NOT EXISTS wallet_control_profiles (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    custody_wallet_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    active_revision_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    activated_at TEXT,
    archived_at TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE CASCADE,
    CONSTRAINT wallet_control_profiles_status_check
        CHECK (status IN ('draft', 'active', 'disabled', 'archived'))
);

CREATE TABLE IF NOT EXISTS wallet_control_profile_revisions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL,
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_action TEXT NOT NULL DEFAULT 'allow',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    activated_at TEXT,
    FOREIGN KEY (profile_id) REFERENCES wallet_control_profiles(id) ON DELETE CASCADE,
    CONSTRAINT wallet_control_profile_revisions_action_check
        CHECK (default_action IN ('allow', 'deny', 'approval_required', 'review')),
    UNIQUE (profile_id, revision_number)
);

CREATE TABLE IF NOT EXISTS api_key_control_profiles (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    api_key_id TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    active_revision_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    activated_at TEXT,
    archived_at TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    CONSTRAINT api_key_control_profiles_status_check
        CHECK (status IN ('draft', 'active', 'disabled', 'archived'))
);

CREATE TABLE IF NOT EXISTS api_key_control_profile_revisions (
    id TEXT PRIMARY KEY,
    profile_id TEXT NOT NULL,
    revision_number INTEGER NOT NULL,
    rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    default_action TEXT NOT NULL DEFAULT 'allow',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    activated_at TEXT,
    FOREIGN KEY (profile_id) REFERENCES api_key_control_profiles(id) ON DELETE CASCADE,
    CONSTRAINT api_key_control_profile_revisions_action_check
        CHECK (default_action IN ('allow', 'deny', 'approval_required', 'review')),
    UNIQUE (profile_id, revision_number)
);

CREATE TABLE IF NOT EXISTS api_key_wallet_policy_bindings (
    id TEXT PRIMARY KEY,
    api_key_id TEXT NOT NULL,
    binding_scope TEXT NOT NULL DEFAULT 'selected',
    wallet_id TEXT,
    custody_wallet_id TEXT,
    wallet_control_profile_id TEXT,
    api_key_control_profile_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE SET NULL,
    FOREIGN KEY (wallet_control_profile_id) REFERENCES wallet_control_profiles(id) ON DELETE SET NULL,
    FOREIGN KEY (api_key_control_profile_id) REFERENCES api_key_control_profiles(id) ON DELETE SET NULL,
    CONSTRAINT api_key_wallet_policy_bindings_scope_check
        CHECK (binding_scope IN ('all', 'selected')),
    CONSTRAINT api_key_wallet_policy_bindings_wallet_check
        CHECK (
            (binding_scope = 'all' AND wallet_id IS NULL AND custody_wallet_id IS NULL)
            OR (binding_scope = 'selected' AND wallet_id IS NOT NULL)
        )
);

CREATE TABLE IF NOT EXISTS wallet_operations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    custody_wallet_id TEXT,
    wallet_id TEXT NOT NULL,
    api_key_id TEXT,
    source TEXT NOT NULL DEFAULT 'api',
    operation_family TEXT NOT NULL,
    operation_type TEXT NOT NULL,
    asset TEXT,
    amount TEXT,
    destination TEXT,
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE SET NULL,
    FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL,
    CONSTRAINT wallet_operations_family_check
        CHECK (operation_family IN ('transfer', 'payment', 'ramp', 'issuance', 'raw_sign', 'program', 'provider_admin')),
    CONSTRAINT wallet_operations_status_check
        CHECK (status IN ('created', 'evaluated', 'pending_approval', 'executing', 'completed', 'failed', 'canceled'))
);

CREATE TABLE IF NOT EXISTS approval_groups (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    archived_at TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT approval_groups_status_check
        CHECK (status IN ('active', 'archived'))
);

CREATE TABLE IF NOT EXISTS approval_group_members (
    id TEXT PRIMARY KEY,
    approval_group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'approver',
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (approval_group_id) REFERENCES approval_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (approval_group_id, user_id)
);

CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    wallet_operation_id TEXT NOT NULL,
    approval_group_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    provider TEXT,
    provider_reference TEXT,
    provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_by TEXT,
    resolved_by TEXT,
    expires_at TEXT,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL,
    FOREIGN KEY (wallet_operation_id) REFERENCES wallet_operations(id) ON DELETE CASCADE,
    FOREIGN KEY (approval_group_id) REFERENCES approval_groups(id) ON DELETE SET NULL,
    CONSTRAINT approval_requests_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'canceled', 'expired', 'failed'))
);

CREATE TABLE IF NOT EXISTS policy_evaluations (
    id TEXT PRIMARY KEY,
    wallet_operation_id TEXT NOT NULL,
    wallet_policy_revision_id TEXT,
    api_key_policy_revision_id TEXT,
    decision TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    reason TEXT,
    matched_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
    requires_approval BOOLEAN NOT NULL DEFAULT false,
    approval_request_id TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (wallet_operation_id) REFERENCES wallet_operations(id) ON DELETE CASCADE,
    FOREIGN KEY (wallet_policy_revision_id) REFERENCES wallet_control_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (api_key_policy_revision_id) REFERENCES api_key_control_profile_revisions(id) ON DELETE SET NULL,
    FOREIGN KEY (approval_request_id) REFERENCES approval_requests(id) ON DELETE SET NULL,
    CONSTRAINT policy_evaluations_decision_check
        CHECK (decision IN ('allow', 'deny', 'approval_required', 'provider_approval_required', 'review', 'not_evaluated'))
);

CREATE TABLE IF NOT EXISTS policy_provider_sync_status (
    id TEXT PRIMARY KEY,
    wallet_control_profile_revision_id TEXT,
    api_key_control_profile_revision_id TEXT,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'not_applicable',
    provider_policy_id TEXT,
    last_synced_at TEXT,
    error TEXT,
    custom_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (wallet_control_profile_revision_id) REFERENCES wallet_control_profile_revisions(id) ON DELETE CASCADE,
    FOREIGN KEY (api_key_control_profile_revision_id) REFERENCES api_key_control_profile_revisions(id) ON DELETE CASCADE,
    CONSTRAINT policy_provider_sync_status_target_check
        CHECK (
            wallet_control_profile_revision_id IS NOT NULL
            OR api_key_control_profile_revision_id IS NOT NULL
        ),
    CONSTRAINT policy_provider_sync_status_status_check
        CHECK (status IN ('not_applicable', 'pending', 'synced', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_control_profiles_org_project
    ON wallet_control_profiles(organization_id, project_id);

CREATE INDEX IF NOT EXISTS idx_wallet_control_profiles_wallet
    ON wallet_control_profiles(custody_wallet_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_control_profiles_active_wallet
    ON wallet_control_profiles(custody_wallet_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_wallet_control_profile_revisions_profile
    ON wallet_control_profile_revisions(profile_id, revision_number DESC);

CREATE INDEX IF NOT EXISTS idx_api_key_control_profiles_org_project
    ON api_key_control_profiles(organization_id, project_id);

CREATE INDEX IF NOT EXISTS idx_api_key_control_profiles_key
    ON api_key_control_profiles(api_key_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_control_profiles_active_key
    ON api_key_control_profiles(api_key_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_api_key_control_profile_revisions_profile
    ON api_key_control_profile_revisions(profile_id, revision_number DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_wallet_policy_bindings_selected
    ON api_key_wallet_policy_bindings(api_key_id, wallet_id)
    WHERE binding_scope = 'selected';

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_wallet_policy_bindings_all
    ON api_key_wallet_policy_bindings(api_key_id)
    WHERE binding_scope = 'all';

CREATE INDEX IF NOT EXISTS idx_api_key_wallet_policy_bindings_custody_wallet
    ON api_key_wallet_policy_bindings(custody_wallet_id);

CREATE INDEX IF NOT EXISTS idx_wallet_operations_org_project_created
    ON wallet_operations(organization_id, project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_operations_wallet_created
    ON wallet_operations(custody_wallet_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_wallet_operations_api_key_created
    ON wallet_operations(api_key_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_operations_org_project_idempotency
    ON wallet_operations(organization_id, COALESCE(project_id, ''), idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_approval_groups_org_project
    ON approval_groups(organization_id, project_id);

CREATE INDEX IF NOT EXISTS idx_approval_group_members_group
    ON approval_group_members(approval_group_id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_operation
    ON approval_requests(wallet_operation_id);

CREATE INDEX IF NOT EXISTS idx_approval_requests_status_created
    ON approval_requests(status, created_at);

CREATE INDEX IF NOT EXISTS idx_policy_evaluations_operation_created
    ON policy_evaluations(wallet_operation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_policy_evaluations_decision_created
    ON policy_evaluations(decision, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_provider_sync_wallet_revision_provider
    ON policy_provider_sync_status(wallet_control_profile_revision_id, provider)
    WHERE wallet_control_profile_revision_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_provider_sync_api_key_revision_provider
    ON policy_provider_sync_status(api_key_control_profile_revision_id, provider)
    WHERE api_key_control_profile_revision_id IS NOT NULL;
