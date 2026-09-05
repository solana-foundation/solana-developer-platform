-- Project-owned Helius Rings upstream bundles (migration 0080). The active
-- default is shared by the default ring and every custom ring in the project;
-- ring records must not select or duplicate these endpoints.
--
-- Endpoint URLs may contain credentials, so the connection row only carries
-- lifecycle and redacted display data. The encrypted payload lives in the
-- existing provider_credentials storage path.

CREATE TABLE IF NOT EXISTS helius_rings_connections (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'helius_rings',
    provider_credential_id TEXT NOT NULL,
    provider_credential_scope_key TEXT NOT NULL,
    network TEXT NOT NULL DEFAULT 'devnet',
    status TEXT NOT NULL DEFAULT 'active',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    allow_insecure_http BOOLEAN NOT NULL DEFAULT FALSE,
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
    ) REFERENCES provider_credentials(id, organization_id, provider, scope_key)
      ON DELETE RESTRICT,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT helius_rings_connections_provider_check
        CHECK (provider = 'helius_rings'),
    CONSTRAINT helius_rings_connections_network_check
        CHECK (network = 'devnet'),
    CONSTRAINT helius_rings_connections_status_check
        CHECK (status IN ('active', 'failed', 'deactivated')),
    CONSTRAINT helius_rings_connections_default_active_check
        CHECK (is_default = FALSE OR status = 'active'),
    CONSTRAINT helius_rings_connections_activation_check
        CHECK (status <> 'active' OR activated_at IS NOT NULL),
    CONSTRAINT helius_rings_connections_deactivation_check
        CHECK (
            (status = 'deactivated' AND deactivated_at IS NOT NULL)
            OR (status <> 'deactivated' AND deactivated_at IS NULL)
        ),
    CONSTRAINT helius_rings_connections_display_metadata_object_check
        CHECK (jsonb_typeof(display_metadata) = 'object'),
    CONSTRAINT helius_rings_connections_id_tenant_key
        UNIQUE (id, organization_id, project_id),
    CONSTRAINT helius_rings_connections_id_project_key
        UNIQUE (id, project_id),
    CONSTRAINT helius_rings_connections_project_name_key
        UNIQUE (project_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_connections_project_default
    ON helius_rings_connections(project_id)
    WHERE is_default AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_helius_rings_connections_project_status
    ON helius_rings_connections(project_id, status, created_at DESC);

-- Operations pin the upstream bundle selected at prepare time.
ALTER TABLE helius_rings_operations
    ADD COLUMN IF NOT EXISTS rings_connection_id TEXT NOT NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'helius_rings_operations_connection_fk'
    ) THEN
        ALTER TABLE helius_rings_operations
            ADD CONSTRAINT helius_rings_operations_connection_fk
                FOREIGN KEY (rings_connection_id, organization_id, project_id)
                REFERENCES helius_rings_connections(id, organization_id, project_id)
                ON DELETE RESTRICT;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_helius_rings_operations_connection
    ON helius_rings_operations(rings_connection_id);
