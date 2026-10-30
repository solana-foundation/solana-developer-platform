import { type ApiTestEnv, apiTestSupport } from "@sdp/api/test-support";
import type { SolanaCluster } from "@sdp/types/well-known-tokens";

const { getDb } = apiTestSupport;

/** The harness's own test chain, set by the CI scripts; the API never reads these. */
interface TestChainEnv {
  SOLANA_RPC_URL?: string;
  SOLANA_NETWORK?: string;
}

function readEnvFromProcess(): ApiTestEnv & TestChainEnv {
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
  return proc as unknown as ApiTestEnv & TestChainEnv;
}

const providedEnv = readEnvFromProcess();

if (!providedEnv.DATABASE_URL) {
  throw new Error("env requires TEST_DATABASE_URL to be set.");
}

export const env = {
  ...providedEnv,
  db: getDb(providedEnv),
};

/**
 * The cluster the test chain stands in for: `SOLANA_NETWORK`, which `vitest.config.ts` defaults to
 * devnet.
 *
 * @returns The run's cluster.
 * @throws When `SOLANA_NETWORK` names no cluster.
 */
function readTestChainCluster(): SolanaCluster {
  const network = providedEnv.SOLANA_NETWORK;
  if (network !== "devnet" && network !== "mainnet-beta") {
    throw new Error(`SOLANA_NETWORK must be devnet or mainnet-beta, got ${network}`);
  }
  return network;
}

export const testChainCluster = readTestChainCluster();

/**
 * The test chain's RPC URL, for suites that cannot run without one.
 *
 * @returns `SOLANA_RPC_URL`.
 * @throws When `SOLANA_RPC_URL` is unset.
 */
export function requireTestChainRpcUrl(): string {
  const rpcUrl = providedEnv.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error("SOLANA_RPC_URL is required for the test chain.");
  }
  return rpcUrl;
}
