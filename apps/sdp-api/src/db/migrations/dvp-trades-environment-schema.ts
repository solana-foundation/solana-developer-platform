import type { Client } from "pg";

/** The migration that records each DvP trade's environment, pinned to its project by a composite foreign key. */
export const DVP_TRADES_ENVIRONMENT_MIGRATION = "0130_dvp_trades_environment.sql";

/**
 * Removes the `dvp_trades.environment` column and the
 * `dvp_trades_project_environment_fkey` foreign key that
 * `0130_dvp_trades_environment.sql` adds. The 0130 `schema_migrations` row is
 * left in place, so a caller that re-runs migrations deletes it to re-apply
 * 0130, and a caller rewinding an earlier migration runs this first, since the
 * foreign key depends on `projects_id_environment_unique`.
 *
 * @param client - Admin connection the DDL runs on.
 * @returns Resolves once the pre-0130 schema is back.
 */
export async function restorePreDvpTradesEnvironmentSchema(client: Client): Promise<void> {
  await client.query(
    [
      "ALTER TABLE dvp_trades DROP CONSTRAINT dvp_trades_project_environment_fkey",
      "ALTER TABLE dvp_trades DROP COLUMN environment",
    ].join(";\n")
  );
}
