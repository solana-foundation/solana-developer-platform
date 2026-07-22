import { getDb } from "@/db";
import type { Env } from "@/types/env";

// CI runs under Doppler. Only pass through the test data-service endpoints so
// ambient provider credentials cannot silently change unit-test behavior.
const providedEnv: Env = {
  ENVIRONMENT: "development",
  API_VERSION: "v1",
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL,
  API_KEY_PEPPER: "test-pepper-for-unit-tests",
  SOLANA_MOCK: "true",
  RUN_INTEGRATION_TESTS: "false",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: "https://solana-rpc.mock.invalid",
  FEE_PAYMENT_PROVIDER: "kora",
  KORA_RPC_URL: "https://kora-rpc.mock.invalid",
};

if (!providedEnv.DATABASE_URL) {
  throw new Error("Test environment requires TEST_DATABASE_URL.");
}
if (!providedEnv.REDIS_URL) {
  throw new Error("Test environment requires REDIS_URL.");
}

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};
