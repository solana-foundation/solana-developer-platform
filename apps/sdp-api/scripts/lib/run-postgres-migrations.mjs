import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const { Client } = pg;
const NON_TRANSACTIONAL_DIRECTIVE = /^--\s*sdp:migration-mode:\s*non-transactional\s*$/m;

export function getPostgresMigrationMode(sql) {
  return NON_TRANSACTIONAL_DIRECTIVE.test(sql) ? "non-transactional" : "transactional";
}

function concurrentIndexName(sql, migrationFile) {
  const withoutComments = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .trim();
  const statements = withoutComments
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  const match = statements[0]?.match(
    /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\b/i
  );

  if (statements.length !== 1 || !match?.[1]) {
    throw new Error(
      `${migrationFile} must contain exactly one CREATE INDEX CONCURRENTLY IF NOT EXISTS statement`
    );
  }

  return match[1];
}

async function applyNonTransactionalMigration({ client, migrationFile, sql }) {
  const indexName = concurrentIndexName(sql, migrationFile);
  const validity = await client.query(
    `SELECT indisvalid
     FROM pg_index
     WHERE indexrelid = to_regclass($1)`,
    [indexName]
  );

  // PostgreSQL can leave an INVALID index behind if a concurrent build is
  // interrupted. IF NOT EXISTS would otherwise skip it forever on retry.
  if (validity.rows[0]?.indisvalid === false) {
    await client.query(`DROP INDEX CONCURRENTLY IF EXISTS "${indexName}"`);
  }

  await client.query(sql);
  await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [migrationFile]);
}

export async function applyPostgresMigration({ client, migrationFile, sql }) {
  if (getPostgresMigrationMode(sql) === "non-transactional") {
    await applyNonTransactionalMigration({ client, migrationFile, sql });
    return;
  }

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
      await applyPostgresMigration({ client, migrationFile, sql });
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
