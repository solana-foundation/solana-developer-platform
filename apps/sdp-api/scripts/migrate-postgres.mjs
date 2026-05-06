import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPostgresMigrations } from "./lib/run-postgres-migrations.mjs";

const appDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const migrationsDir = path.join(appDir, "src/db/migrations/postgres");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

try {
  await runPostgresMigrations({ databaseUrl, migrationsDir });
  console.log("Postgres migrations are up to date.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
