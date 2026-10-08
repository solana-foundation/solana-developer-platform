import type { Client } from "pg";

/** The migration that drops custody defaults and pins Managed custody configs to Sandbox. */
export const CUSTODY_DEFAULTS_DROP_MIGRATION = "0126_drop_custody_defaults.sql";

/**
 * Restores every object `0126_drop_custody_defaults.sql` drops or replaces, in
 * its post-0125 shape, and removes what 0126 adds. The 0126 `schema_migrations`
 * row is left in place, so a caller that re-runs migrations to exercise an
 * earlier file deletes it afterwards to re-apply 0126. The custody tables must
 * be empty, since the restored constraints are added without a backfill.
 *
 * @param client - Admin connection the DDL runs on.
 * @returns Resolves once the pre-0126 schema is back.
 */
export async function restorePreCustodyDefaultsDropSchema(client: Client): Promise<void> {
  await client.query(
    [
      "ALTER TABLE custody_configs DROP COLUMN project_environment",
      "ALTER TABLE projects DROP CONSTRAINT projects_id_environment_unique",
      `ALTER TABLE custody_connections
         DROP CONSTRAINT custody_connections_credential_scope_check,
         ADD CONSTRAINT custody_connections_credential_scope_check
           CHECK (
             (scope = 'organization' AND provider_credential_scope_key = '__organization__')
             OR (scope = 'project' AND provider_credential_scope_key IN ('__organization__', project_id))
           )`,
      `ALTER TABLE custody_connections
         DROP CONSTRAINT custody_connections_active_lifecycle_check,
         ADD CONSTRAINT custody_connections_active_lifecycle_check
           CHECK (
             status <> 'active'
             OR (
               last_check_status IS NOT NULL
               AND last_check_status = 'success'
               AND last_check_at IS NOT NULL
               AND default_custody_wallet_id IS NOT NULL
               AND activated_at IS NOT NULL
             )
           ),
         ADD CONSTRAINT custody_connections_default_wallet_owner_fkey
           FOREIGN KEY (default_custody_wallet_id, id)
           REFERENCES custody_wallets(id, custody_connection_id)
           ON DELETE SET NULL (default_custody_wallet_id)`,
      `ALTER TABLE custody_configs
         ADD COLUMN default_wallet_id TEXT,
         ADD CONSTRAINT custody_configs_default_wallet_fkey
           FOREIGN KEY (id, default_wallet_id)
           REFERENCES custody_wallets(custody_config_id, wallet_id)
           DEFERRABLE INITIALLY DEFERRED`,
      `CREATE TABLE custody_scope_defaults (
         id TEXT PRIMARY KEY,
         organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
         project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
         default_custody_config_id TEXT,
         default_custody_connection_id TEXT,
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         CONSTRAINT custody_scope_defaults_default_custody_config_id_fkey
           FOREIGN KEY (default_custody_config_id)
           REFERENCES custody_configs(id)
           ON DELETE NO ACTION,
         CONSTRAINT custody_scope_defaults_default_custody_connection_id_fkey
           FOREIGN KEY (default_custody_connection_id, organization_id, project_id)
           REFERENCES custody_connections(id, organization_id, project_id)
           ON DELETE NO ACTION,
         CONSTRAINT custody_scope_defaults_has_target
           CHECK (default_custody_config_id IS NOT NULL OR default_custody_connection_id IS NOT NULL)
       )`,
      `CREATE UNIQUE INDEX idx_custody_scope_defaults_org_project
         ON custody_scope_defaults (organization_id, project_id)`,
      `CREATE INDEX idx_custody_scope_defaults_default_config
         ON custody_scope_defaults (default_custody_config_id)`,
    ].join(";\n")
  );
}
