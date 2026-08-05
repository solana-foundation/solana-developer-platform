ALTER TABLE custody_connections
    ADD CONSTRAINT custody_connections_id_org_project_key
        UNIQUE (id, organization_id, project_id);

ALTER TABLE custody_scope_defaults
    ADD COLUMN default_custody_connection_id TEXT,
    ALTER COLUMN default_custody_config_id DROP NOT NULL,
    DROP CONSTRAINT custody_scope_defaults_default_custody_config_id_fkey;

ALTER TABLE custody_scope_defaults
    ADD CONSTRAINT custody_scope_defaults_default_custody_config_id_fkey
        FOREIGN KEY (default_custody_config_id)
        REFERENCES custody_configs(id)
        ON DELETE NO ACTION,
    ADD CONSTRAINT custody_scope_defaults_default_custody_connection_id_fkey
        FOREIGN KEY (
            default_custody_connection_id,
            organization_id,
            project_id
        )
        REFERENCES custody_connections(id, organization_id, project_id)
        ON DELETE NO ACTION,
    ADD CONSTRAINT custody_scope_defaults_has_target
        CHECK (
            default_custody_config_id IS NOT NULL
            OR default_custody_connection_id IS NOT NULL
        ),
    ADD CONSTRAINT custody_scope_defaults_connection_project_only
        CHECK (
            default_custody_connection_id IS NULL
            OR project_id IS NOT NULL
        );

CREATE INDEX idx_custody_scope_defaults_default_connection
    ON custody_scope_defaults(default_custody_connection_id)
    WHERE default_custody_connection_id IS NOT NULL;
