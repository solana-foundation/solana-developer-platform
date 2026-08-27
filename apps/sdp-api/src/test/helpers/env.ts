import { getDb } from "@/db";
import { TEST_RUNTIME_PASSWORD, TEST_RUNTIME_ROLE } from "@/test/runtime-role";
import type { Env } from "@/types/env";

const workerId = process.env.VITEST_POOL_ID;
const baseDatabaseUrl = process.env.TEST_DATABASE_URL;
const baseRedisUrl = process.env.REDIS_URL;

if (!workerId) {
  throw new Error("Test environment requires VITEST_POOL_ID (unit tests must run under vitest).");
}
if (!baseDatabaseUrl) {
  throw new Error("Test environment requires TEST_DATABASE_URL.");
}
if (!baseRedisUrl) {
  throw new Error("Test environment requires REDIS_URL.");
}

/**
 * Points this worker at the `<base>_w<id>_test` database cloned for it by
 * node-global-setup.ts, so parallel workers never share tables.
 *
 * @param baseUrl - Connection URI of the migrated base database.
 * @param id - This worker's VITEST_POOL_ID.
 * @returns The worker-scoped Postgres connection URI.
 */
function workerDatabaseUrl(baseUrl: string, id: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname}_w${id}_test`;
  return url.toString();
}

/**
 * Points this worker at the Redis logical database matching its
 * VITEST_POOL_ID, isolating KV state between parallel workers.
 *
 * @param baseUrl - Connection URI of the shared Redis container.
 * @param id - This worker's VITEST_POOL_ID.
 * @returns The worker-scoped Redis connection URI.
 */
function workerRedisUrl(baseUrl: string, id: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${id}`;
  return url.toString();
}

/**
 * This worker's database as the container's superuser/table owner. Reserved
 * for work that genuinely needs owner powers — running migration DDL in
 * migration tests — because a superuser bypasses the tenant-isolation RLS
 * policies entirely.
 */
export const adminDatabaseUrl = workerDatabaseUrl(baseDatabaseUrl, workerId);

/**
 * The same worker database through the plain NOSUPERUSER/NOBYPASSRLS runtime
 * role (created by node-global-setup.ts), mirroring the production posture
 * from docs/ops/audit-ledger.md. Everything the app-under-test and the
 * repositories touch goes through this role so the tenant-isolation policies
 * from migration 0073 are actually enforced in tests.
 */
function runtimeDatabaseUrl(adminUrl: string): string {
  const url = new URL(adminUrl);
  url.username = TEST_RUNTIME_ROLE;
  url.password = TEST_RUNTIME_PASSWORD;
  return url.toString();
}

// CI runs under Doppler. Only pass through the test data-service endpoints so
// ambient provider credentials cannot silently change unit-test behavior.
const providedEnv: Env = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  DATABASE_URL: runtimeDatabaseUrl(adminDatabaseUrl),
  REDIS_URL: workerRedisUrl(baseRedisUrl, workerId),
  API_KEY_PEPPER: "test-pepper-for-unit-tests",
  CREDENTIAL_FINGERPRINT_PEPPER: "test-credential-fingerprint-pepper-for-unit-tests",
  SOLANA_MOCK: "true",
  RUN_INTEGRATION_TESTS: "false",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: "https://solana-rpc.mock.invalid",
  FEE_PAYMENT_PROVIDER: "kora",
  KORA_RPC_URL: "https://kora-rpc.mock.invalid",
};

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};
