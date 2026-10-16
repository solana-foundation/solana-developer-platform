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
 * from migration 0079 are actually enforced in tests.
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
  // Every module, so a test opts out of one by naming a stricter channel.
  SDP_RELEASE_CHANNEL: "experimental",
  // Unit requests supply deterministic proxy headers rather than a socket.
  TRUST_PROXY_HEADERS: "true",
  DATABASE_URL: runtimeDatabaseUrl(adminDatabaseUrl),
  REDIS_URL: workerRedisUrl(baseRedisUrl, workerId),
  API_KEY_PEPPER: "test-pepper-for-unit-tests",
  CREDENTIAL_FINGERPRINT_PEPPER: "test-credential-fingerprint-pepper-for-unit-tests",
  SPC_CREDENTIAL_ENCRYPTION_KEY: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=",
  SOLANA_MOCK: "true",
  RUN_INTEGRATION_TESTS: "false",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: "https://solana-rpc.mock.invalid",
  FEE_PAYMENT_PROVIDER: "kora",
  KORA_RPC_URL: "https://kora-rpc.mock.invalid",
  // The minted metadata origin comes only from this trusted config value —
  // deploys that need the SDP-hosted metadata fallback fail closed without it.
  PUBLIC_API_ORIGIN: "http://localhost",
};

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};

const MANAGED_RPC_ENV_KEYS = [
  "SOLANA_RPC_URL",
  "SOLANA_RPC_DEFAULT_PROVIDER",
  "SOLANA_RPC_TRITON_URL",
  "SOLANA_RPC_TRITON_API_KEY",
  "SOLANA_RPC_HELIUS_URL",
  "SOLANA_RPC_HELIUS_API_KEY",
  "SOLANA_RPC_ALCHEMY_URL",
  "SOLANA_RPC_ALCHEMY_API_KEY",
  "SOLANA_RPC_QUICKNODE_URL",
  "SOLANA_RPC_QUICKNODE_API_KEY",
  "SOLANA_RPC_VALIDATIONCLOUD_URL",
  "SOLANA_RPC_VALIDATIONCLOUD_API_KEY",
  "SOLANA_RPC_NODIT_URL",
  "SOLANA_RPC_NODIT_API_KEY",
] as const satisfies readonly (keyof Env)[];

/**
 * Unset every managed RPC pool key on the shared test `env`, so a relay test
 * configures exactly the providers it names.
 *
 * @returns Nothing; mutates `env` in place.
 */
export function resetManagedRpcEnv(): void {
  for (const key of MANAGED_RPC_ENV_KEYS) {
    env[key] = undefined;
  }
}
