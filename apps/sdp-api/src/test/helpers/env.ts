import { getDb } from "@/db";
import { LocalPiiCipher } from "@/services/pii-cipher/pii-cipher";
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

// CI runs under Doppler. Only pass through the test data-service endpoints so
// ambient provider credentials cannot silently change unit-test behavior.
const providedEnv: Env = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  DATABASE_URL: workerDatabaseUrl(baseDatabaseUrl, workerId),
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
  counterpartyPiiCipher: new LocalPiiCipher("BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc="),
};
