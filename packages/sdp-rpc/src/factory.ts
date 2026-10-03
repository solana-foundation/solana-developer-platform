import {
  GENESIS_HASH_BY_CLUSTER,
  type OrganizationRpcProvider,
  type SolanaCluster,
} from "@sdp/types";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";
import { SdpRpcError } from "./errors";
import {
  createFailoverTransport,
  DEFAULT_RPC_REQUEST_TIMEOUT_MS,
  type SolanaRpc,
  withRequestTimeout,
} from "./solana";
import type { ManagedRpcEnv } from "./types";

/**
 * Each cluster's managed pool env keys. Provider order is the failover order when no
 * preferred provider is named; `default` (often a public endpoint) last.
 */
const MANAGED_RPC_ENV_KEYS = {
  devnet: {
    preferredProvider: "SOLANA_RPC_DEFAULT_PROVIDER_DEVNET",
    urls: {
      triton: "SOLANA_RPC_TRITON_URL_DEVNET",
      helius: "SOLANA_RPC_HELIUS_URL_DEVNET",
      alchemy: "SOLANA_RPC_ALCHEMY_URL_DEVNET",
      quicknode: "SOLANA_RPC_QUICKNODE_URL_DEVNET",
      validationcloud: "SOLANA_RPC_VALIDATIONCLOUD_URL_DEVNET",
      nodit: "SOLANA_RPC_NODIT_URL_DEVNET",
      default: "SOLANA_RPC_DEFAULT_URL_DEVNET",
    },
  },
  "mainnet-beta": {
    preferredProvider: "SOLANA_RPC_DEFAULT_PROVIDER_MAINNET",
    urls: {
      triton: "SOLANA_RPC_TRITON_URL_MAINNET",
      helius: "SOLANA_RPC_HELIUS_URL_MAINNET",
      alchemy: "SOLANA_RPC_ALCHEMY_URL_MAINNET",
      quicknode: "SOLANA_RPC_QUICKNODE_URL_MAINNET",
      validationcloud: "SOLANA_RPC_VALIDATIONCLOUD_URL_MAINNET",
      nodit: "SOLANA_RPC_NODIT_URL_MAINNET",
      default: "SOLANA_RPC_DEFAULT_URL_MAINNET",
    },
  },
} as const satisfies Record<
  SolanaCluster,
  {
    preferredProvider: keyof ManagedRpcEnv;
    urls: Record<OrganizationRpcProvider, keyof ManagedRpcEnv>;
  }
>;

/** `<cluster> <url>` pairs whose genesis hash matched; only matches are cached. */
const verifiedGenesis = new Set<string>();

/**
 * The managed endpoint URLs for one cluster, preferred provider first, duplicates removed.
 *
 * @param env - Process env carrying the keys in `MANAGED_RPC_ENV_KEYS`.
 * @param cluster - The cluster whose pool to read.
 * @returns At least one URL.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no URL, or the preferred provider has none.
 */
function managedRpcUrls(env: ManagedRpcEnv, cluster: SolanaCluster): string[] {
  const keys = MANAGED_RPC_ENV_KEYS[cluster];
  const configured = Object.entries(keys.urls).flatMap(([provider, envKey]) => {
    const url = env[envKey];
    return url ? [{ provider, url }] : [];
  });
  if (configured.length === 0) {
    throw new SdpRpcError("RPC_NOT_CONFIGURED", `No RPC endpoint is configured for ${cluster}`, {
      cluster,
    });
  }
  const preferredProvider = env[keys.preferredProvider];
  const preferred = configured.filter((entry) => entry.provider === preferredProvider);
  if (preferredProvider && preferred.length === 0) {
    throw new SdpRpcError(
      "RPC_NOT_CONFIGURED",
      `${keys.preferredProvider} names ${preferredProvider}, which has no ${cluster} URL`,
      { cluster, provider: preferredProvider }
    );
  }
  return [...new Set([...preferred, ...configured].map((entry) => entry.url))];
}

/**
 * Wrap one endpoint's transport so its first request proves the endpoint serves `cluster`.
 * A probe network error propagates as an ordinary transport failure (failover may hop);
 * a mismatch throws a non-transient error, so failover and retries stop on it.
 *
 * @param transport - The raw transport for `url`.
 * @param cluster - The cluster the endpoint is configured for.
 * @param url - The endpoint URL, used only as the cache key.
 * @returns A transport that probes `getGenesisHash` until a match is cached.
 */
function withGenesisGuard(
  transport: RpcTransport,
  cluster: SolanaCluster,
  url: string
): RpcTransport {
  const cacheKey = `${cluster} ${url}`;
  return async <TResponse>(request: Parameters<RpcTransport>[0]) => {
    if (!verifiedGenesis.has(cacheKey)) {
      const genesisHash = await createSolanaRpcFromTransport(transport)
        .getGenesisHash()
        .send({ abortSignal: request.signal });
      if (genesisHash !== GENESIS_HASH_BY_CLUSTER[cluster]) {
        throw new SdpRpcError(
          "RPC_CLUSTER_MISMATCH",
          `An RPC endpoint configured for ${cluster} serves a different cluster`,
          { cluster, genesisHash }
        );
      }
      verifiedGenesis.add(cacheKey);
    }
    return await transport<TResponse>(request);
  };
}

/**
 * The Solana RPC client for `cluster`, over that cluster's managed provider pool with
 * per-request failover, a per-attempt deadline, and a genesis guard on every endpoint.
 * Callers needing a tighter deadline pass `abortSignal` to `.send()`.
 *
 * Request code never calls this: it reads `c.get("clusterContext").rpc`, which
 * `projectContextMiddleware` builds from the project's environment. The only callers are that
 * middleware, Earn's anonymous context, and the job helper `clusterFor(row)`, each deriving
 * `cluster` from a persisted row, never from caller input.
 *
 * @param env - Process env carrying the per-cluster managed pool.
 * @param cluster - The cluster every request must reach.
 * @returns The RPC client.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster's pool is empty or its preferred provider is missing.
 */
export function createRpc(env: ManagedRpcEnv, cluster: SolanaCluster): SolanaRpc {
  const urls = managedRpcUrls(env, cluster);
  const transports = urls.map((url) =>
    withRequestTimeout(
      withGenesisGuard(createDefaultRpcTransport({ url }), cluster, url),
      DEFAULT_RPC_REQUEST_TIMEOUT_MS
    )
  );
  return createSolanaRpcFromTransport(
    createFailoverTransport(transports, { stickyKey: urls.join("|") })
  );
}
