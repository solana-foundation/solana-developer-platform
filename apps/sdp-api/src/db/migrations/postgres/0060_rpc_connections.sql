-- Tenant-owned RPC connections (HOO-1092).
--
-- Mirrors custody_connections: a connection binds one provider_credentials row
-- to a provider, scope, and lifecycle state. Secret material never lands here —
-- it lives behind CredentialSecretStore and is referenced only through the
-- credential row.
--
-- Two things custody does not need:
--   * network — the same organization can hold different credentials for devnet
--     and mainnet-beta, so a connection is only ever effective for one.
--   * is_default — the relay picks one connection per scope and network, and
--     that choice has to be storable rather than inferred from ordering.

CREATE TABLE IF NOT EXISTS rpc_connections (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    provider TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_key TEXT GENERATED ALWAYS AS (COALESCE(project_id, '__organization__')) STORED,
    provider_credential_id TEXT NOT NULL,
    provider_credential_scope_key TEXT NOT NULL,
    network TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    setup_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    display_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_check_status TEXT,
    last_check_at TEXT,
    last_check_failure_code TEXT,
    activated_at TEXT,
    deactivated_at TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    -- The composite reference is the cross-tenant guard: a connection cannot
    -- name a credential belonging to another organization, another provider, or
    -- a scope it is not allowed to read, because no such parent row exists.
    FOREIGN KEY (
        provider_credential_id,
        organization_id,
        provider,
        provider_credential_scope_key
    )
        REFERENCES provider_credentials(id, organization_id, provider, scope_key)
        ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT rpc_connections_scope_check
        CHECK (
            (scope = 'organization' AND project_id IS NULL)
            OR (scope = 'project' AND project_id IS NOT NULL)
        ),
    CONSTRAINT rpc_connections_project_scope_key_check
        CHECK (project_id IS NULL OR project_id <> '__organization__'),
    -- A project connection may borrow an organization credential; an
    -- organization connection may never reach down into a project's.
    CONSTRAINT rpc_connections_credential_scope_check
        CHECK (
            (
                scope = 'organization'
                AND provider_credential_scope_key = '__organization__'
            )
            OR (
                scope = 'project'
                AND provider_credential_scope_key IN ('__organization__', project_id)
            )
        ),
    CONSTRAINT rpc_connections_network_check
        CHECK (network IN ('devnet', 'mainnet-beta')),
    CONSTRAINT rpc_connections_status_check
        CHECK (status IN ('pending', 'checking', 'active', 'failed', 'deactivated')),
    CONSTRAINT rpc_connections_last_check_status_check
        CHECK (
            last_check_status IS NULL
            OR last_check_status IN ('pending', 'running', 'success', 'failed', 'retry_unknown')
        ),
    CONSTRAINT rpc_connections_setup_metadata_object
        CHECK (jsonb_typeof(setup_metadata) = 'object'),
    CONSTRAINT rpc_connections_display_metadata_object
        CHECK (jsonb_typeof(display_metadata) = 'object'),
    CONSTRAINT rpc_connections_activated_at_status_check
        CHECK (
            (status = 'active' AND activated_at IS NOT NULL)
            OR (status <> 'active')
        ),
    CONSTRAINT rpc_connections_deactivated_at_status_check
        CHECK (
            (status = 'deactivated' AND deactivated_at IS NOT NULL)
            OR (status <> 'deactivated' AND deactivated_at IS NULL)
        ),
    -- `activated_at` is history, not current state: once a connection has been
    -- live, a later failed probe must not have to erase the fact that it was.
    -- Leaving 'failed' out here made re-checking a live connection whose
    -- provider had started rejecting the key violate this constraint instead of
    -- recording the failure, so the row stayed 'active' with a stale success.
    CONSTRAINT rpc_connections_activated_at_lifecycle_check
        CHECK (
            activated_at IS NULL
            OR status IN ('active', 'failed', 'deactivated')
        ),
    -- Only a live connection can be the one the relay picks.
    CONSTRAINT rpc_connections_default_requires_active
        CHECK (is_default = FALSE OR status = 'active')
);

-- "Only one effective default per scope and network." Partial so that
-- deactivated history keeps its flag without competing for the slot.
CREATE UNIQUE INDEX IF NOT EXISTS rpc_connections_one_default_per_scope_network
    ON rpc_connections (organization_id, scope_key, network)
    WHERE is_default AND status = 'active';

-- The relay's read path: organization + scope + network, newest first.
CREATE INDEX IF NOT EXISTS rpc_connections_scope_lookup
    ON rpc_connections (organization_id, scope_key, network, status);

CREATE INDEX IF NOT EXISTS rpc_connections_credential
    ON rpc_connections (provider_credential_id);
