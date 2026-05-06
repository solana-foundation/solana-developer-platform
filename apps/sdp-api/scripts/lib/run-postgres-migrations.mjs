import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;

export async function runPostgresMigrations({ databaseUrl, migrationsDir }) {
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
  } finally {
    await client.end().catch(() => {});
  }
}

export async function ensureDatabaseExists({ databaseUrl }) {
  const url = new URL(databaseUrl);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!dbName) {
    throw new Error(`Cannot determine database name from connection string: ${databaseUrl}`);
  }

  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";

  const client = new Client({ connectionString: adminUrl.toString() });

  try {
    await client.connect();
    const { rowCount } = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      dbName,
    ]);
    if (rowCount === 0) {
      const quoted = `"${dbName.replace(/"/g, '""')}"`;
      await client.query(`CREATE DATABASE ${quoted}`);
      console.log(`Created database ${dbName}.`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}
