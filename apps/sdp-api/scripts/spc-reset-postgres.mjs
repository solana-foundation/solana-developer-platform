import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;

const appDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const sqlPath = path.join(appDir, "src/db/scripts/spc-reset.sql");
const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const sql = fs.readFileSync(sqlPath, "utf8");
const client = new Client({ connectionString: databaseUrl });

try {
  await client.connect();
  await client.query(sql);
  console.log("Dropped Private Channels tables and their schema_migrations rows.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
} finally {
  await client.end().catch(() => {});
}
