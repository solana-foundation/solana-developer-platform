import type { Client } from "pg";

/** The migration that makes project_id NOT NULL and drops pre-cutover Production chain rows. */
export const PROJECT_ID_NOT_NULL_MIGRATION = "0129_project_id_not_null.sql";

const NOT_NULL_PROJECT_TABLES = [
  "payment_transfers",
  "payment_requests",
  "counterparties",
  "custody_connections",
] as const;

const EARN_PROJECT_ENVIRONMENT_FOREIGN_KEYS = [
  ["earn_provider_wallets", "earn_provider_wallets_project_environment_fkey"],
  ["earn_positions", "earn_positions_project_environment_fkey"],
  ["earn_vault_withdrawal_requests", "earn_vault_withdrawal_requests_project_environment_fkey"],
  [
    "earn_vault_withdrawal_request_actions",
    "earn_vault_withdrawal_request_actions_project_environment_fkey",
  ],
  [
    "earn_vault_withdrawal_request_reservations",
    "earn_vault_withdrawal_reservations_project_environment_fkey",
  ],
  ["earn_movements", "earn_movements_project_environment_fkey"],
  ["earn_split_swap_advisories", "earn_split_swap_advisories_project_environment_fkey"],
  [
    "earn_external_wallet_transactions",
    "earn_external_wallet_transactions_project_environment_fkey",
  ],
  [
    "earn_external_wallet_withdrawal_request_transactions",
    "earn_external_wallet_withdrawal_txns_project_environment_fkey",
  ],
] as const;

/**
 * Restores every object `0129_project_id_not_null.sql` drops or tightens, in its
 * post-0127 shape, and removes the foreign keys 0129 adds. The 0129
 * `schema_migrations` row is left in place, so a caller that re-runs migrations
 * deletes it to re-apply 0129, and a caller rewinding an earlier migration runs
 * this first, since 0129's Earn keys depend on `projects_id_environment_unique`.
 *
 * @param client - Admin connection the DDL runs on.
 * @returns Resolves once the pre-0129 schema is back.
 */
export async function restorePreProjectIdNotNullSchema(client: Client): Promise<void> {
  await client.query(
    [
      ...EARN_PROJECT_ENVIRONMENT_FOREIGN_KEYS.map(
        ([table, constraint]) => `ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`
      ),
      `ALTER TABLE sponsorship_budget_reservations
         DROP CONSTRAINT sponsorship_budget_reservations_project_id_fkey,
         ALTER COLUMN project_id DROP NOT NULL`,
      ...NOT_NULL_PROJECT_TABLES.map(
        (table) => `ALTER TABLE ${table} ALTER COLUMN project_id DROP NOT NULL`
      ),
      `CREATE TABLE signing_requests (
         id TEXT PRIMARY KEY,
         organization_id TEXT NOT NULL,
         custody_config_id TEXT,
         token_transaction_id TEXT,
         external_request_id TEXT,
         status TEXT NOT NULL DEFAULT 'pending',
         transaction_message TEXT NOT NULL,
         signatures TEXT,
         metadata TEXT,
         created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
         completed_at TEXT,
         project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
         FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
         FOREIGN KEY (custody_config_id) REFERENCES custody_configs(id) ON DELETE SET NULL,
         FOREIGN KEY (token_transaction_id) REFERENCES issuance_transactions(id) ON DELETE SET NULL
       )`,
      "CREATE INDEX idx_signing_requests_status ON signing_requests(status)",
      "CREATE INDEX idx_signing_requests_external ON signing_requests(external_request_id)",
      "CREATE INDEX idx_signing_requests_org ON signing_requests(organization_id)",
      "CREATE INDEX idx_signing_requests_token_tx ON signing_requests(token_transaction_id)",
      "CREATE INDEX idx_signing_requests_org_project ON signing_requests(organization_id, project_id)",
      "ALTER TABLE signing_requests ENABLE ROW LEVEL SECURITY",
      "ALTER TABLE signing_requests FORCE ROW LEVEL SECURITY",
      "CREATE POLICY sdp_tenant_isolation ON signing_requests" +
        " USING (sdp_tenant_isolation_allows(organization_id))" +
        " WITH CHECK (sdp_tenant_isolation_allows(organization_id))",
    ].join(";\n")
  );
}
