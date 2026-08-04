import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDatabaseExists, runPostgresMigrations } from "./lib/run-postgres-migrations.mjs";

const appDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const migrationsDir = path.join(appDir, "src/db/migrations/postgres");

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error("db:migrate:test requires TEST_DATABASE_URL to be set.");
  process.exit(1);
}

try {
  await ensureDatabaseExists({ databaseUrl });
  await runPostgresMigrations({ databaseUrl, migrationsDir });
  console.log("Test postgres migrations are up to date.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
