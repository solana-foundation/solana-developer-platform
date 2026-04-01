import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const requiredTables = [
  "schema_migrations",
  "organizations",
  "users",
  "projects",
  "api_keys",
  "issued_tokens",
  "custody_wallets",
  "payment_transfers",
];

const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query("SELECT 1");

  const { rows } = await client.query(
    `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
    `,
    [requiredTables]
  );

  const foundTables = new Set(rows.map((row) => row.table_name));
  const missingTables = requiredTables.filter((tableName) => !foundTables.has(tableName));

  if (missingTables.length > 0) {
    console.error(`Missing required tables: ${missingTables.join(", ")}`);
    process.exit(1);
  }

  const latestMigration = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"
  );

  if (latestMigration.rowCount === 0) {
    console.error("schema_migrations is empty");
    process.exit(1);
  }

  console.log(
    `Postgres verification succeeded. Latest migration: ${latestMigration.rows[0].version}`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
