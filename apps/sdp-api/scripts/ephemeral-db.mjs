/**
 * Lifecycle for an ephemeral per-PR database (PRO-1767). Bundled into the
 * image as ephemeral-db.js and run inside the VPC as a Cloud Run job
 * execution, because the dev Cloud SQL instance is unreachable from Actions.
 *
 *   node ephemeral-db.js ensure   create EPHEMERAL_DB_NAME if missing, then
 *                                 run migrations against it
 *   node ephemeral-db.js drop     terminate connections, drop the database,
 *                                 flush the PR's redis db
 *
 * DATABASE_URL stays the shared dev URL and serves as the admin connection;
 * the PR database name comes from EPHEMERAL_DB_NAME.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import Redis from "ioredis";
import pg from "pg";
import { runPostgresMigrations } from "./lib/run-postgres-migrations.mjs";

const { Client } = pg;

const mode = process.argv[2];
const dbName = process.env.EPHEMERAL_DB_NAME?.trim();
const baseUrl = process.env.DATABASE_URL?.trim();

if (mode !== "ensure" && mode !== "drop") {
  console.error("usage: ephemeral-db.mjs <ensure|drop>");
  process.exit(1);
}
if (!dbName || !/^[a-z][a-z0-9_]{0,62}$/.test(dbName)) {
  console.error("EPHEMERAL_DB_NAME is required and must match [a-z][a-z0-9_]*");
  process.exit(1);
}
if (!baseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const prUrl = new URL(baseUrl);
prUrl.pathname = `/${dbName}`;
if (new URL(baseUrl).pathname === prUrl.pathname) {
  console.error(`refusing to manage the shared database "${dbName}"`);
  process.exit(1);
}

const admin = new Client({ connectionString: baseUrl });
await admin.connect();
try {
  if (mode === "ensure") {
    try {
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`created database ${dbName}`);
    } catch (error) {
      if (error.code !== "42P04") throw error;
      console.log(`database ${dbName} already exists`);
    }
  } else {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [dbName]
    );
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    console.log(`dropped database ${dbName}`);
  }
} finally {
  await admin.end();
}

if (mode === "ensure") {
  const appDir = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const migrationsDir =
    process.env.MIGRATIONS_DIR?.trim() || path.join(appDir, "src/db/migrations/postgres");
  await runPostgresMigrations({ databaseUrl: prUrl.toString(), migrationsDir });
  console.log(`migrations applied to ${dbName}`);
} else {
  const redisUrl = process.env.REDIS_URL?.trim();
  const redisDb = process.env.EPHEMERAL_REDIS_DB?.trim();
  const skipRedis = process.argv.includes("skip-redis");
  if (skipRedis) {
    console.log("skip-redis: this environment lost its redis claim; not flushing");
  }
  if (!skipRedis && redisUrl && redisDb) {
    const url = new URL(redisUrl);
    url.pathname = `/${redisDb}`;
    const redis = new Redis(url.toString(), { maxRetriesPerRequest: 3, lazyConnect: true });
    try {
      await redis.connect();
      await redis.flushdb();
      console.log(`flushed redis db ${redisDb}`);
    } finally {
      redis.disconnect();
    }
  }
}
