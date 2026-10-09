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
 * Each cluster's managed pool env key per provider. Key order is the failover order;
 * `default` (often a public endpoint) last.
 */
const MANAGED_RPC_ENV_KEYS = {
  devnet: {
    triton: "SOLANA_RPC_TRITON_DEVNET_API_KEY_URL",
    helius: "SOLANA_RPC_HELIUS_DEVNET_API_KEY_URL",
    alchemy: "SOLANA_RPC_ALCHEMY_DEVNET_API_KEY_URL",
    quicknode: "SOLANA_RPC_QUICKNODE_DEVNET_API_KEY_URL",
    validationcloud: "SOLANA_RPC_VALIDATIONCLOUD_DEVNET_API_KEY_URL",
    nodit: "SOLANA_RPC_NODIT_DEVNET_API_KEY_URL",
    default: "SOLANA_RPC_DEFAULT_DEVNET_API_KEY_URL",
  },
  "mainnet-beta": {
    triton: "SOLANA_RPC_TRITON_MAINNET_API_KEY_URL",
    helius: "SOLANA_RPC_HELIUS_MAINNET_API_KEY_URL",
    alchemy: "SOLANA_RPC_ALCHEMY_MAINNET_API_KEY_URL",
    quicknode: "SOLANA_RPC_QUICKNODE_MAINNET_API_KEY_URL",
    validationcloud: "SOLANA_RPC_VALIDATIONCLOUD_MAINNET_API_KEY_URL",
    nodit: "SOLANA_RPC_NODIT_MAINNET_API_KEY_URL",
    default: "SOLANA_RPC_DEFAULT_MAINNET_API_KEY_URL",
  },
} as const satisfies Record<SolanaCluster, Record<OrganizationRpcProvider, keyof ManagedRpcEnv>>;

/** How long a genesis match is trusted before re-probing: the node behind a URL can be repointed. */
const GENESIS_PROOF_TTL_MS = 30_000;

/** `<cluster> <endpointUrl>` to the time its last genesis match expires; only matches are recorded. */
const genesisProofExpiry = new Map<string, number>();

/**
 * Wrap one endpoint's transport so it proves the endpoint serves `cluster` before the first
 * request and again once the previous proof is older than `GENESIS_PROOF_TTL_MS`.
 * A probe network error propagates as an ordinary transport failure (failover may hop);
 * a mismatch throws a non-transient error, so failover and retries stop on it.
 *
 * @param endpointTransport - The raw transport for `endpointUrl`.
 * @param cluster - The cluster the endpoint is configured for.
 * @param endpointUrl - The endpoint URL, used only as the proof cache key.
 * @returns A transport that probes `getGenesisHash` whenever no unexpired match is recorded.
 */
function withGenesisGuard(
  endpointTransport: RpcTransport,
  cluster: SolanaCluster,
  endpointUrl: string
): RpcTransport {
  const genesisProofKey = `${cluster} ${endpointUrl}`;
  return async <TResponse>(rpcRequest: Parameters<RpcTransport>[0]) => {
    const proofExpiresAt = genesisProofExpiry.get(genesisProofKey);
    if (proofExpiresAt === undefined || proofExpiresAt <= Date.now()) {
      const servedGenesisHash = await createSolanaRpcFromTransport(endpointTransport)
        .getGenesisHash()
        .send({ abortSignal: rpcRequest.signal });
      if (servedGenesisHash !== GENESIS_HASH_BY_CLUSTER[cluster]) {
        throw new SdpRpcError(
          "RPC_CLUSTER_MISMATCH",
          `An RPC endpoint configured for ${cluster} serves a different cluster`,
          { cluster, genesisHash: servedGenesisHash }
        );
      }
      genesisProofExpiry.set(genesisProofKey, Date.now() + GENESIS_PROOF_TTL_MS);
    }
    return await endpointTransport<TResponse>(rpcRequest);
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
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
export function createRpc(env: ManagedRpcEnv, cluster: SolanaCluster): SolanaRpc {
  const endpointUrls = Object.values(MANAGED_RPC_ENV_KEYS[cluster]).flatMap((envKey) => {
    const endpointUrl = env[envKey];
    return endpointUrl ? [endpointUrl] : [];
  });
  if (endpointUrls.length === 0) {
    throw new SdpRpcError("RPC_NOT_CONFIGURED", `No RPC endpoint is configured for ${cluster}`, {
      cluster,
    });
  }
  const guardedEndpointTransports = endpointUrls.map((endpointUrl) =>
    withRequestTimeout(
      withGenesisGuard(createDefaultRpcTransport({ url: endpointUrl }), cluster, endpointUrl),
      DEFAULT_RPC_REQUEST_TIMEOUT_MS
    )
  );
  return createSolanaRpcFromTransport(
    createFailoverTransport(guardedEndpointTransports, { stickyKey: endpointUrls.join("|") })
  );
}
