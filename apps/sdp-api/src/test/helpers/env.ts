import { getDb } from "@/db";
import { getProcessEnv } from "@/lib/runtime-env";
import type { Env } from "@/types/env";

const processEnv = getProcessEnv();

const providedEnv: Env = {
  ...processEnv,
  ENVIRONMENT: "development",
  API_VERSION: processEnv.API_VERSION ?? "v1",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? processEnv.DATABASE_URL,
  REDIS_URL: processEnv.REDIS_URL,
  API_KEY_PEPPER: processEnv.API_KEY_PEPPER ?? "test-pepper-for-unit-tests",
  SOLANA_MOCK: "true",
  RUN_INTEGRATION_TESTS: "false",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_URL: "https://solana-rpc.mock.invalid",
  FEE_PAYMENT_PROVIDER: "kora",
  KORA_RPC_URL: "https://kora-rpc.mock.invalid",
};

if (!providedEnv.DATABASE_URL) {
  throw new Error("Test environment requires TEST_DATABASE_URL or DATABASE_URL.");
}
if (!providedEnv.REDIS_URL) {
  throw new Error("Test environment requires REDIS_URL.");
}

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};
