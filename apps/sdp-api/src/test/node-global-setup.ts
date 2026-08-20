import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer, type StartedRedisContainer } from "@testcontainers/redis";
import pg from "pg";
import { runPostgresMigrations } from "../../scripts/lib/run-postgres-migrations.mjs";
import { TEST_RUNTIME_PASSWORD, TEST_RUNTIME_ROLE } from "./runtime-role";
import { TEST_WORKER_COUNT } from "./worker-count";

const POSTGRES_IMAGE = "postgres:16-alpine";
const REDIS_IMAGE = "redis:7-alpine";

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../db/migrations/postgres");

let postgres: StartedPostgreSqlContainer | undefined;
let redis: StartedRedisContainer | undefined;

export async function setup(): Promise<void> {
  try {
    const [postgresResult, redisResult] = await Promise.allSettled([
      new PostgreSqlContainer(POSTGRES_IMAGE)
        .withCommand(["postgres", "-c", "max_connections=200"])
        .start(),
      new RedisContainer(REDIS_IMAGE).start(),
    ]);

    if (postgresResult.status === "fulfilled") postgres = postgresResult.value;
    if (redisResult.status === "fulfilled") redis = redisResult.value;

    if (postgresResult.status === "rejected" || redisResult.status === "rejected") {
      const failed = [postgresResult, redisResult]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
      throw new Error(`Failed to start test containers: ${failed.join("; ")}`);
    }

    const databaseUrl = postgresResult.value.getConnectionUri();
    const redisUrl = `redis://${redisResult.value.getHost()}:${redisResult.value.getMappedPort(6379)}`;
    process.env.TEST_DATABASE_URL = databaseUrl;
    process.env.REDIS_URL = redisUrl;

    await runPostgresMigrations({ databaseUrl, migrationsDir });
    await createRuntimeRole(databaseUrl);
    await createWorkerDatabases(databaseUrl);

    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
  } catch (error) {
    await teardown();
    throw error;
  }
}

export async function teardown(): Promise<void> {
  process.off("SIGINT", handleSignal);
  process.off("SIGTERM", handleSignal);
  await Promise.allSettled([postgres?.stop(), redis?.stop()]);
  postgres = undefined;
  redis = undefined;
}

function handleSignal(): void {
  void teardown().finally(() => process.exit(1));
}

/**
 * The testcontainers bootstrap user (`test`) is a superuser and the table
 * owner, so PostgreSQL would never evaluate the tenant-isolation RLS policies
 * (migration 0063) for it. Tests exercise the app through this plain
 * NOSUPERUSER/NOBYPASSRLS role instead — the same posture
 * docs/ops/audit-ledger.md requires of production runtimes. Grants are issued
 * on the base database before the template clone so every worker database
 * inherits them; the role itself is cluster-level.
 */
async function createRuntimeRole(databaseUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      `CREATE ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`
    );
    await client.query(`GRANT USAGE ON SCHEMA public TO ${TEST_RUNTIME_ROLE}`);
    // TRUNCATE is required by seedTestDatabase's reset between tests.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO ${TEST_RUNTIME_ROLE}`
    );
    await client.query(
      `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${TEST_RUNTIME_ROLE}`
    );
    // TRUNCATE ... RESTART IDENTITY passes owner checks only. Role membership
    // confers ownership rights, but NOT the owner's SUPERUSER/BYPASSRLS
    // attributes (PostgreSQL never inherits role attributes) — and every
    // tenant-isolation policy is FORCEd, which binds owners too. The
    // enforcement suite in src/db/tenant-isolation.test.ts proves RLS still
    // applies to this role.
    const owner = new URL(databaseUrl).username || "test";
    await client.query(`GRANT "${owner}" TO ${TEST_RUNTIME_ROLE}`);
  } finally {
    await client.end();
  }
}

/**
 * Clones the migrated base database into one database per vitest worker
 * (`<base>_w1_test` .. `<base>_wN_test`). Workers select theirs by
 * VITEST_POOL_ID in src/test/helpers/env.ts, so parallel test files never
 * share tables. The `_test` suffix is load-bearing: the append-only audit
 * triggers (migration 0047) only permit TRUNCATE in databases named `test`
 * or `*_test`.
 *
 * @param databaseUrl - Connection URI of the migrated base database, used as the CREATE DATABASE template.
 * @returns Resolves once every worker database exists.
 */
async function createWorkerDatabases(databaseUrl: string): Promise<void> {
  const baseUrl = new URL(databaseUrl);
  const baseName = baseUrl.pathname.slice(1);
  const adminUrl = new URL(databaseUrl);
  adminUrl.pathname = "/postgres";
  const client = new pg.Client({ connectionString: adminUrl.toString() });
  await client.connect();
  try {
    for (let workerId = 1; workerId <= TEST_WORKER_COUNT; workerId++) {
      await client.query(`CREATE DATABASE "${baseName}_w${workerId}_test" TEMPLATE "${baseName}"`);
    }
  } finally {
    await client.end();
  }
}
