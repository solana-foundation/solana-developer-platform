import type { Client } from "pg";

/** The migration that makes project_id required on every project-owned payments, sponsorship and credential table. */
export const PROJECT_ID_NOT_NULL_MIGRATION = "0129_project_id_not_null.sql";

/**
 * Restores every constraint `0129_project_id_not_null.sql` tightens to its
 * pre-0129 shape and deletes the 0129 `schema_migrations` row, so the next
 * runner pass re-applies 0129 against whatever the caller seeds in between.
 *
 * @param client - Admin connection the DDL runs on.
 * @returns Resolves once the pre-0129 schema is back.
 */
export async function restorePreProjectIdNotNullSchema(client: Client): Promise<void> {
  await client.query(
    [
      "ALTER TABLE payment_transfers ALTER COLUMN project_id DROP NOT NULL",
      "ALTER TABLE payment_requests ALTER COLUMN project_id DROP NOT NULL",
      "ALTER TABLE counterparties ALTER COLUMN project_id DROP NOT NULL",
      `ALTER TABLE sponsorship_budget_reservations
         ALTER COLUMN project_id DROP NOT NULL,
         DROP CONSTRAINT sponsorship_budget_reservations_project_id_fkey`,
      `ALTER TABLE provider_credentials
         ALTER COLUMN project_id DROP NOT NULL,
         DROP CONSTRAINT provider_credentials_scope_check,
         ADD CONSTRAINT provider_credentials_scope_check
           CHECK (
             (scope = 'organization' AND project_id IS NULL)
             OR (scope = 'project' AND project_id IS NOT NULL)
           )`,
      `ALTER TABLE custody_connections
         ALTER COLUMN project_id DROP NOT NULL,
         DROP CONSTRAINT custody_connections_scope_check,
         ADD CONSTRAINT custody_connections_scope_check
           CHECK (
             (scope = 'organization' AND project_id IS NULL)
             OR (scope = 'project' AND project_id IS NOT NULL)
           )`,
      `DELETE FROM schema_migrations WHERE version = '${PROJECT_ID_NOT_NULL_MIGRATION}'`,
    ].join(";\n")
  );
}
