import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const appDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const migrationsDir = path.join(appDir, "src/db/migrations/postgres");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const migrationFiles = fs
  .readdirSync(migrationsDir)
  .filter((file) => file.endsWith(".sql"))
  .sort((left, right) => left.localeCompare(right));

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT timezone('UTC', now())::text
    )
  `);

  const appliedRows = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(appliedRows.rows.map((row) => row.version));

  for (const migrationFile of migrationFiles) {
    if (applied.has(migrationFile)) {
      continue;
    }

    const sql = fs.readFileSync(path.join(migrationsDir, migrationFile), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migrationFile]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  console.log("Postgres migrations are up to date.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
