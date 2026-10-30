import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";
import { SOLANA_CLUSTERS } from "@sdp/types/well-known-tokens";
import { z } from "zod";

const { getDb } = apiTestSupport;

/**
 * The harness's own test chain, set by the CI scripts; the API never reads these.
 * `vitest.config.ts` defaults `SOLANA_NETWORK` to devnet.
 */
const testChainEnvSchema = z.object({
  SOLANA_RPC_URL: z.url().optional(),
  SOLANA_NETWORK: z.enum(SOLANA_CLUSTERS),
});

const testChainEnv = testChainEnvSchema.parse(process.env);

function readEnvFromProcess(): ApiTestEnv {
  const proc: Record<string, string | undefined> = { ...process.env };
  proc.DATABASE_URL = proc.TEST_DATABASE_URL;
  if (proc.SDP_INTEGRATION_CUSTODY_PROVIDER === "local" && !proc.SDP_DEPLOYMENT_MODE) {
    proc.SDP_DEPLOYMENT_MODE = "self_hosted";
  }
  // A deploy without an issuer-supplied uri mints the SDP-hosted metadata URL,
  // which now comes only from PUBLIC_API_ORIGIN and fails closed when unset
  // (HOO-1013). The value is arbitrary against a local surfpool, so default it
  // for integration runs while still exercising the hosted-metadata path.
  if (!proc.PUBLIC_API_ORIGIN) {
    proc.PUBLIC_API_ORIGIN = "http://localhost:8787";
  }
  return proc as unknown as ApiTestEnv;
}

const providedEnv = readEnvFromProcess();

if (!providedEnv.DATABASE_URL) {
  throw new Error("env requires TEST_DATABASE_URL to be set.");
}

export const env = {
  ...providedEnv,
  ...testChainEnv,
  db: getDb(providedEnv),
};

/** The cluster the test chain stands in for. */
export const testChainCluster = testChainEnv.SOLANA_NETWORK;

/**
 * The test chain's RPC URL, for suites that cannot run without one.
 *
 * @returns `SOLANA_RPC_URL`.
 * @throws When `SOLANA_RPC_URL` is unset.
 */
export function requireTestChainRpcUrl(): string {
  const rpcUrl = testChainEnv.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL is required for the test chain.");
  }
  return rpcUrl;
}
