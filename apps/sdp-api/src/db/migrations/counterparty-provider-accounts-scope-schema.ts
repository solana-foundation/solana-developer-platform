import type { Client } from "pg";

/** The migration that binds each counterparty provider account to its counterparty's organization and project. */
export const COUNTERPARTY_PROVIDER_ACCOUNTS_SCOPE_FK_MIGRATION =
  "0132_counterparty_provider_accounts_scope_fk.sql";

/**
 * Restores the single-column counterparty foreign key that
 * `0132_counterparty_provider_accounts_scope_fk.sql` replaces and deletes the
 * 0132 `schema_migrations` row, so the next runner pass re-applies 0132
 * against whatever the caller seeds in between. Any test that rewinds an
 * earlier migration and seeds provider accounts the composite key rejects
 * must call this first.
 *
 * @param client - Admin connection the DDL runs on.
 * @returns Resolves once the pre-0132 schema is back.
 */
export async function restorePreCounterpartyProviderAccountsScopeSchema(
  client: Client
): Promise<void> {
  await client.query(
    [
      `ALTER TABLE counterparty_provider_accounts
         DROP CONSTRAINT counterparty_provider_accounts_counterparty_scope_fkey,
         ADD CONSTRAINT counterparty_provider_accounts_counterparty_id_fkey
           FOREIGN KEY (counterparty_id) REFERENCES counterparties (id)`,
      `DELETE FROM schema_migrations WHERE version = '${COUNTERPARTY_PROVIDER_ACCOUNTS_SCOPE_FK_MIGRATION}'`,
    ].join(";\n")
  );
}
