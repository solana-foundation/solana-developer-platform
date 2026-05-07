import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDatabaseExists, runPostgresMigrations } from "./lib/run-postgres-migrations.mjs";

// biome-ignore lint/security/noSecrets: Local Docker Postgres fallback for isolated tests.
const TEST_DATABASE_URL_FALLBACK = "postgresql://sdp:sdp@127.0.0.1:5432/sdp_test";

// Keep this in sync with apps/sdp-api/vitest.config.ts so vitest and
// `pnpm db:migrate:test` always agree on which database to use.
function deriveTestDatabaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, "")) || "sdp";
  url.pathname = `/${encodeURIComponent(`${dbName}_test`)}`;
  return url.toString();
}

const appDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const migrationsDir = path.join(appDir, "src/db/migrations/postgres");

const explicitTestDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
const baseDatabaseUrl = process.env.DATABASE_URL?.trim();
const databaseUrl =
  explicitTestDatabaseUrl ||
  (baseDatabaseUrl ? deriveTestDatabaseUrl(baseDatabaseUrl) : TEST_DATABASE_URL_FALLBACK);

try {
  await ensureDatabaseExists({ databaseUrl });
  await runPostgresMigrations({ databaseUrl, migrationsDir });
  console.log("Test postgres migrations are up to date.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
