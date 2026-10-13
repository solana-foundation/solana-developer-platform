import { afterEach, beforeEach } from "node:test";
import { runInClusterScope } from "@sdp/rpc/scope";
import type { SdpEnvironment, SolanaCluster } from "@sdp/types";

/** The one managed pool endpoint each cluster serves in catalogue tests, unless a test repoints it. */
export const CATALOGUE_RPC_URLS = {
  devnet: "https://devnet.earn-catalogue.test",
  "mainnet-beta": "https://mainnet-beta.earn-catalogue.test",
} as const satisfies Record<SolanaCluster, string>;

const POOL_ENV_KEY_BY_CLUSTER = {
  devnet: "SOLANA_RPC_TRITON_DEVNET_API_KEY_URL",
  "mainnet-beta": "SOLANA_RPC_TRITON_MAINNET_API_KEY_URL",
} as const satisfies Record<SolanaCluster, string>;

const MANAGED_POOL_ENV_KEY = /^SOLANA_RPC_[A-Z]+_(?:DEVNET|MAINNET)_API_KEY_URL$/;

/**
 * Remove every managed pool variable from `process.env`.
 *
 * @returns Nothing; the pool is empty afterwards.
 */
function clearManagedPool(): void {
  for (const envKey of Object.keys(process.env)) {
    if (MANAGED_POOL_ENV_KEY.test(envKey)) delete process.env[envKey];
  }
}

/**
 * Give each cluster's managed pool exactly its {@link CATALOGUE_RPC_URLS} endpoint for every test
 * of the enclosing `describe` (or file), and put back whatever pool the process had afterwards.
 * Opens no cluster scope; tests do, with {@link runInCatalogueScope}. Register at `describe` or
 * file level.
 *
 * @returns Nothing; it registers `beforeEach` and `afterEach` hooks.
 */
export function isolateCataloguePool(): void {
  let ambientPool: Record<string, string | undefined> = {};

  beforeEach(() => {
    ambientPool = Object.fromEntries(
      Object.entries(process.env).filter(([envKey]) => MANAGED_POOL_ENV_KEY.test(envKey))
    );
    clearManagedPool();
    pointCataloguePool("devnet", CATALOGUE_RPC_URLS.devnet);
    pointCataloguePool("mainnet-beta", CATALOGUE_RPC_URLS["mainnet-beta"]);
  });

  afterEach(() => {
    clearManagedPool();
    Object.assign(process.env, ambientPool);
  });
}

/**
 * Point `cluster`'s managed pool at `endpointUrl` for the rest of the current test, or leave the
 * cluster with no endpoint at all when it is null. A test that answers a wrong genesis hash needs
 * an endpoint no earlier test proved, because the door trusts a successful proof for 30 seconds.
 *
 * @param cluster - The cluster whose pool to repoint.
 * @param endpointUrl - The pool's only endpoint, or null for none.
 * @returns Nothing; `process.env` holds the new pool.
 */
export function pointCataloguePool(cluster: SolanaCluster, endpointUrl: string | null): void {
  const envKey = POOL_ENV_KEY_BY_CLUSTER[cluster];
  if (endpointUrl === null) {
    delete process.env[envKey];
    return;
  }
  process.env[envKey] = endpointUrl;
}

/**
 * Run `work` inside the cluster scope the catalogue cron opens for one environment's reads: that
 * environment and no project.
 *
 * @param environment - The environment whose catalogue pass `work` stands in for.
 * @param work - The provider read under test.
 * @returns Whatever `work` returns.
 */
export function runInCatalogueScope<TResult>(
  environment: SdpEnvironment,
  work: () => TResult
): TResult {
  return runInClusterScope({ projectId: null, environment }, work);
}
