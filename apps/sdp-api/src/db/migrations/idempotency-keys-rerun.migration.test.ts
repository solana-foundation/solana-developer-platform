import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDatabaseUrl as databaseUrl } from "@/test/helpers/env";
import { runPostgresMigrations } from "../../../scripts/lib/run-postgres-migrations.mjs";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");

/**
 * The Idempotency-Key migrations (HOO-1918) re-run over themselves. The runner
 * records a migration by its file name, and these files were renumbered more
 * than once as main took their numbers (dev applied them under earlier names):
 * there a renamed file runs again over the columns, indexes and constraint it
 * already made.
 */
const RERUNNABLE = [
  "0133_idempotency_keys.sql",
  "0134_recurring_payment_idempotency.sql",
  "0135_recurring_attempt_idempotency_keys.sql",
  "0136_custody_wallet_idempotency.sql",
] as const;

describe("Idempotency-Key migrations", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it.each(RERUNNABLE)("%s applies again where it already applied", async (file) => {
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [file]);

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    const { rows } = await client.query(
      "SELECT version FROM schema_migrations WHERE version = $1",
      [file]
    );
    expect(rows).toEqual([{ version: file }]);
  });
});
