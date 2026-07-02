-- Bridge tables for BYO custody provider credentials.
-- Secret material lives in an external secret store, runtime env, or encrypted DB fallback.

CREATE TABLE IF NOT EXISTS provider_credentials (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    scope TEXT NOT NULL,
    scope_key TEXT GENERATED ALWAYS AS (COALESCE(project_id, '__organization__')) STORED,
    source TEXT NOT NULL,
    storage_backend TEXT NOT NULL,
    secret_ref TEXT,
    secret_version_ref TEXT,
    encrypted_secret_payload TEXT,
    display_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    credential_version INTEGER NOT NULL DEFAULT 1,
    rotated_from_provider_credential_id TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    deactivated_at TEXT,
    last_validated_at TEXT,
    last_failed_at TEXT,
    last_failure_code TEXT,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (rotated_from_provider_credential_id)
        REFERENCES provider_credentials(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (id, organization_id, provider, scope_key),
    CONSTRAINT provider_credentials_scope_check
        CHECK (
            (scope = 'organization' AND project_id IS NULL)
            OR (scope = 'project' AND project_id IS NOT NULL)
        ),
    CONSTRAINT provider_credentials_project_scope_key_check
        CHECK (project_id IS NULL OR project_id <> '__organization__'),
    CONSTRAINT provider_credentials_source_check
        CHECK (source IN ('stored', 'runtime')),
    CONSTRAINT provider_credentials_storage_backend_check
        CHECK (storage_backend IN ('gcp_secret_manager', 'encrypted_db', 'runtime_env')),
    CONSTRAINT provider_credentials_status_check
        CHECK (status IN ('pending', 'active', 'failed_validation', 'retired', 'deactivated')),
    CONSTRAINT provider_credentials_version_positive
        CHECK (credential_version > 0),
    CONSTRAINT provider_credentials_display_metadata_object
        CHECK (jsonb_typeof(display_metadata) = 'object'),
    CONSTRAINT provider_credentials_deactivated_at_status_check
        CHECK (
            (status = 'deactivated' AND deactivated_at IS NOT NULL)
            OR (status <> 'deactivated' AND deactivated_at IS NULL)
        ),
    CONSTRAINT provider_credentials_secret_location_check
        CHECK (
            (
                source = 'runtime'
                AND storage_backend = 'runtime_env'
                AND secret_ref IS NULL
                AND secret_version_ref IS NULL
                AND encrypted_secret_payload IS NULL
            )
            OR (
                source = 'stored'
                AND storage_backend = 'gcp_secret_manager'
                AND secret_ref IS NOT NULL
                AND encrypted_secret_payload IS NULL
            )
            OR (
                source = 'stored'
                AND storage_backend = 'encrypted_db'
                AND secret_ref IS NULL
                AND encrypted_secret_payload IS NOT NULL
            )
        )
);

CREATE INDEX IF NOT EXISTS idx_provider_credentials_org_provider_status
    ON provider_credentials(organization_id, provider, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_provider_credentials_project_provider_status
    ON provider_credentials(organization_id, project_id, provider, status, updated_at)
    WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_credentials_secret_ref
    ON provider_credentials(secret_ref)
    WHERE secret_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_provider_credentials_rotated_from
    ON provider_credentials(rotated_from_provider_credential_id)
    WHERE rotated_from_provider_credential_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS custody_connections (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    provider TEXT NOT NULL,
    scope TEXT NOT NULL,
    provider_credential_id TEXT NOT NULL,
    provider_credential_scope_key TEXT NOT NULL,
    default_custody_wallet_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
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
    FOREIGN KEY (
        provider_credential_id,
        organization_id,
        provider,
        provider_credential_scope_key
    )
        REFERENCES provider_credentials(id, organization_id, provider, scope_key)
        ON DELETE CASCADE,
    FOREIGN KEY (default_custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE SET NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT custody_connections_scope_check
        CHECK (
            (scope = 'organization' AND project_id IS NULL)
            OR (scope = 'project' AND project_id IS NOT NULL)
        ),
    CONSTRAINT custody_connections_credential_scope_check
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
    CONSTRAINT custody_connections_status_check
        CHECK (status IN ('pending', 'checking', 'active', 'failed', 'deactivated')),
    CONSTRAINT custody_connections_last_check_status_check
        CHECK (
            last_check_status IS NULL
            OR last_check_status IN ('pending', 'running', 'success', 'failed', 'retry_unknown')
        ),
    CONSTRAINT custody_connections_setup_metadata_object
        CHECK (jsonb_typeof(setup_metadata) = 'object'),
    CONSTRAINT custody_connections_display_metadata_object
        CHECK (jsonb_typeof(display_metadata) = 'object'),
    CONSTRAINT custody_connections_activated_at_status_check
        CHECK (
            (status = 'active' AND activated_at IS NOT NULL)
            OR (status <> 'active')
        ),
    CONSTRAINT custody_connections_deactivated_at_status_check
        CHECK (
            (status = 'deactivated' AND deactivated_at IS NOT NULL)
            OR (status <> 'deactivated' AND deactivated_at IS NULL)
        ),
    CONSTRAINT custody_connections_activated_at_lifecycle_check
        CHECK (
            activated_at IS NULL
            OR status IN ('active', 'deactivated')
        )
);

-- Multiple active connections per provider/scope are intentional for rotation overlap
-- and explicit project selection.
CREATE INDEX IF NOT EXISTS idx_custody_connections_org_provider_status
    ON custody_connections(organization_id, provider, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_custody_connections_project_provider_status
    ON custody_connections(organization_id, project_id, provider, status, updated_at)
    WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_custody_connections_provider_credential
    ON custody_connections(provider_credential_id);

CREATE INDEX IF NOT EXISTS idx_custody_connections_default_wallet
    ON custody_connections(default_custody_wallet_id)
    WHERE default_custody_wallet_id IS NOT NULL;
