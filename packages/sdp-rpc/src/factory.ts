import {
  GENESIS_HASH_BY_CLUSTER,
  type OrganizationRpcProvider,
  type SolanaCluster,
} from "@sdp/types";
import {
  createDefaultRpcTransport,
  createJsonRpcApi,
  createRpc,
  createSolanaRpcFromTransport,
  getAbortablePromise,
  getSolanaErrorFromJsonRpcError,
  isJsonRpcPayload,
  isSolanaError,
  type Rpc,
  type RpcRequest,
  type RpcResponse,
  type RpcTransport,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
} from "@solana/kit";
import { SdpRpcError, solanaRpcError } from "./errors";
import { withRpcReadContext } from "./read-context";
import { withInFlightReadSharing } from "./read-sharing";
import { currentClusterScope } from "./scope";
import { withReadSocketRetry } from "./socket-retry";
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS, type SolanaRpc } from "./solana";
import { isTransientRpcError } from "./transient";
import type { ManagedRpcEnv } from "./types";

/** The managed pool's failover order; `default` (often a public endpoint) last. */
const MANAGED_RPC_FAILOVER_ORDER = [
  "triton",
  "helius",
  "alchemy",
  "quicknode",
  "validationcloud",
  "nodit",
  "default",
] as const satisfies readonly OrganizationRpcProvider[];

/** Each cluster's managed pool env key per provider. */
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

/** The probe's own deadline; it never runs under a caller's signal, since its result is shared. */
const GENESIS_PROBE_TIMEOUT_MS = 10_000;

/**
 * JSON-RPC errors a node answers with HTTP 200 when it can't serve the request yet (unhealthy,
 * behind the requested slot, missing history or block status). Kit's HTTP transport only throws
 * on non-2xx, so the pool reads these from the body and asks the next endpoint.
 */
const FAILOVER_JSON_RPC_ERROR_CODES = [
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
] as const;

/** `<cluster> <endpointUrl>` to the time its last genesis match expires; only matches are recorded. */
const genesisProofExpiry = new Map<string, number>();

/** `<cluster> <endpointUrl>` to the probe in flight, so concurrent requests share one probe. */
const genesisProbes = new Map<string, Promise<void>>();

/**
 * How long an endpoint that failed or couldn't serve stays at the back of its pool's order, so
 * requests return to the preferred provider once it recovers.
 */
const ENDPOINT_COOLDOWN_MS = 30_000;

/** Pool key (cluster plus its endpoint URLs) to the memoized pool transport every client shares. */
const clusterPoolTransports = new Map<string, RpcTransport>();

/** Pool key to the memoized client. */
const clusterRpcs = new Map<string, SolanaRpc>();

/** Pool key to the memoized in-flight read sharing over that pool. */
const clusterSharedReadTransports = new Map<string, RpcTransport>();

/** `<timeoutMs> <poolKey>` to the memoized bounded client. */
const clusterBoundedRpcs = new Map<string, SolanaRpc>();

/** `<timeoutMs> <poolKey>` to the memoized read client. */
const clusterReadRpcs = new Map<string, SolanaRpc>();

/** `<timeoutMs> <poolKey>` to the memoized JSON-RPC fetch. */
const clusterJsonRpcFetches = new Map<string, typeof fetch>();

/** Behaviour options for a scope client: never a URL or a cluster, which come from the scope. */
export type ClusterRpcOptions = Readonly<{
  /** End-to-end deadline for each request, failover hops and genesis probes included. */
  timeoutMs: number;
}>;

/** `<cluster> <heliusUrl>` to the memoized DAS client. */
const clusterDasRpcs = new Map<string, DasRpc>();

/** Helius DAS `displayOptions`. */
export type DasDisplayOptions = Readonly<{ showFungible: boolean }>;

/** Helius DAS `searchAssets` params, as SDP sends them (one owner's fungible tokens). */
export type DasSearchAssetsParams = Readonly<{
  ownerAddress: string;
  tokenType: "fungible";
  page: number;
  limit: number;
  displayOptions: DasDisplayOptions;
}>;

/** Helius DAS `getAssetBatch` params. */
export type DasGetAssetBatchParams = Readonly<{
  ids: readonly string[];
  displayOptions: DasDisplayOptions;
}>;

/**
 * The fungible-token fields of a Helius DAS asset that SDP reads. Every field is optional:
 * Helius omits what it doesn't index, and amounts arrive as numbers or strings.
 */
export type DasTokenInfo = Readonly<{
  amount?: number | string | null;
  balance?: number | string | null;
  decimals?: number | null;
  mint?: string | null;
  symbol?: string | null;
  uiAmount?: number | string | null;
  ui_amount?: number | string | null;
  uiAmountString?: string | null;
  ui_amount_string?: string | null;
  price_info?: Readonly<{
    price_per_token?: number | null;
    currency?: string | null;
  }> | null;
}>;

/** One Helius DAS asset, narrowed to the fields SDP reads. */
export type DasAsset = Readonly<{
  id?: string;
  content?: Readonly<{
    metadata?: Readonly<{
      symbol?: string | null;
    }>;
  }>;
  token_info?: DasTokenInfo | null;
}>;

/** Helius DAS `searchAssets` result. */
export type DasSearchAssetsResult = Readonly<{
  items?: readonly DasAsset[];
}>;

/** The Helius DAS methods SDP calls. */
export type DasApi = {
  searchAssets(params: DasSearchAssetsParams): DasSearchAssetsResult;
  getAssetBatch(params: DasGetAssetBatchParams): readonly DasAsset[];
};

/** A kit RPC client over {@link DasApi}. */
export type DasRpc = Rpc<DasApi>;

/**
 * Bound every request through `transport` by `timeoutMs`, combined with the caller's own signal
 * when it has one, so a caller signal never removes the deadline. Whichever fires first aborts.
 *
 * @param transport - The transport to bound.
 * @param timeoutMs - The per-attempt deadline.
 * @returns A transport whose deadline expiry rejects with a transient-classified timeout.
 */
function withAttemptDeadline(transport: RpcTransport, timeoutMs: number): RpcTransport {
  return async <TResponse>(rpcRequest: Parameters<RpcTransport>[0]) => {
    const deadline = new AbortController();
    const deadlineReason = new Error("RPC attempt deadline elapsed");
    const timer = setTimeout(() => deadline.abort(deadlineReason), timeoutMs);
    const signal = rpcRequest.signal
      ? AbortSignal.any([rpcRequest.signal, deadline.signal])
      : deadline.signal;
    try {
      return await transport<TResponse>({ ...rpcRequest, signal });
    } catch (cause) {
      if (signal.aborted && signal.reason === deadlineReason) {
        throw solanaRpcError(`RPC request timed out after ${timeoutMs}ms`, { timedOut: true });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Prove `endpointTransport` serves `cluster`, sharing one in-flight probe per endpoint.
 *
 * @param endpointTransport - The endpoint's transport below the caller deadline.
 * @param cluster - The cluster the endpoint is configured for.
 * @param genesisProofKey - The endpoint's proof cache key.
 * @returns Resolves once the endpoint's genesis hash matches `cluster`.
 * @throws SdpRpcError `RPC_CLUSTER_MISMATCH` when the endpoint serves another cluster.
 */
function proveGenesis(
  endpointTransport: RpcTransport,
  cluster: SolanaCluster,
  genesisProofKey: string
): Promise<void> {
  const probeInFlight = genesisProbes.get(genesisProofKey);
  if (probeInFlight) return probeInFlight;
  const probe = (async () => {
    const servedGenesisHash = await createSolanaRpcFromTransport(
      withAttemptDeadline(endpointTransport, GENESIS_PROBE_TIMEOUT_MS)
    )
      .getGenesisHash()
      .send();
    if (servedGenesisHash !== GENESIS_HASH_BY_CLUSTER[cluster]) {
      throw new SdpRpcError(
        "RPC_CLUSTER_MISMATCH",
        `An RPC endpoint configured for ${cluster} serves a different cluster`,
        { cluster, genesisHash: servedGenesisHash }
      );
    }
    genesisProofExpiry.set(genesisProofKey, Date.now() + GENESIS_PROOF_TTL_MS);
  })().finally(() => genesisProbes.delete(genesisProofKey));
  genesisProbes.set(genesisProofKey, probe);
  return probe;
}

/**
 * Wrap one endpoint's transport so it proves the endpoint serves `cluster` before the first
 * request and again once the previous proof is older than `GENESIS_PROOF_TTL_MS`.
 * A probe network error propagates as an ordinary transport failure (failover may hop);
 * a mismatch throws a non-transient error, so failover and retries stop on it. A caller whose
 * signal aborts while the probe runs stops waiting; the probe continues for other callers.
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
      try {
        await getAbortablePromise(
          proveGenesis(endpointTransport, cluster, genesisProofKey),
          rpcRequest.signal
        );
      } catch (cause) {
        if (rpcRequest.signal?.aborted || !isTransientRpcError(cause)) throw cause;
        throw new UnsentRequestError(cause);
      }
    }
    return await endpointTransport<TResponse>(rpcRequest);
  };
}

/**
 * Prove `endpointUrl` serves `cluster`, for callers that send raw JSON-RPC instead of going
 * through `createClusterRpc()`. Shares the door's per-endpoint proof cache and in-flight probe,
 * so an endpoint the door already proved costs nothing.
 *
 * @param cluster - The cluster the endpoint is configured for.
 * @param endpointUrl - The managed pool endpoint.
 * @returns Resolves once the endpoint holds an unexpired genesis match for `cluster`.
 * @throws SdpRpcError `RPC_CLUSTER_MISMATCH` when the endpoint serves another cluster.
 */
export async function assertEndpointServesCluster(
  cluster: SolanaCluster,
  endpointUrl: string
): Promise<void> {
  const genesisProofKey = `${cluster} ${endpointUrl}`;
  const proofExpiresAt = genesisProofExpiry.get(genesisProofKey);
  if (proofExpiresAt !== undefined && proofExpiresAt > Date.now()) return;
  await proveGenesis(createDefaultRpcTransport({ url: endpointUrl }), cluster, genesisProofKey);
}

/**
 * A transient failure that happened before the request left SDP (the genesis probe failed), so
 * the pool may try another endpoint even for `sendTransaction`.
 */
class UnsentRequestError extends Error {
  constructor(public readonly cause: unknown) {
    super("The request was not sent: its endpoint could not be proven", { cause });
  }
}

/**
 * Whether a JSON-RPC response body says the node can't serve the request yet.
 *
 * @param response - The decoded JSON-RPC response.
 * @returns `true` when its error maps to one of `FAILOVER_JSON_RPC_ERROR_CODES`.
 */
function asksForAnotherEndpoint(response: unknown): boolean {
  if (typeof response !== "object" || response === null || !("error" in response)) return false;
  const servedError = getSolanaErrorFromJsonRpcError(response.error);
  return FAILOVER_JSON_RPC_ERROR_CODES.some((code) => isSolanaError(servedError, code));
}

/**
 * A pool's endpoint indexes in failover order, with those that failed within
 * `ENDPOINT_COOLDOWN_MS` of `now` moved to the back in their original order.
 *
 * @param lastFailedAt - Each endpoint's last failure time, by endpoint index.
 * @param now - The current time.
 * @returns The endpoint indexes to attempt, in order.
 */
function endpointAttemptOrder(lastFailedAt: readonly number[], now: number): number[] {
  const endpointIndexes = lastFailedAt.map((_, endpointIndex) => endpointIndex);
  const isCoolingDown = (endpointIndex: number) =>
    now - lastFailedAt[endpointIndex] < ENDPOINT_COOLDOWN_MS;
  return [
    ...endpointIndexes.filter((endpointIndex) => !isCoolingDown(endpointIndex)),
    ...endpointIndexes.filter(isCoolingDown),
  ];
}

/**
 * Per-request failover across a cluster's endpoints. Every request walks the endpoints in
 * failover order, with those that failed in the last `ENDPOINT_COOLDOWN_MS` moved to the back, so
 * one blip never parks the process on a worse provider. A transient transport failure or a
 * `FAILOVER_JSON_RPC_ERROR_CODES` body moves to the next endpoint; the last endpoint's answer is
 * returned as-is so kit raises its typed error, and a caller abort stops the walk.
 * `sendTransaction` fails over only when the request never left SDP (`UnsentRequestError`): any
 * later failure can arrive after the transaction reached the leader, and resubmitting elsewhere
 * is the send primitive's decision, not the pool's.
 *
 * @param endpointTransports - The guarded endpoint transports, in failover order.
 * @returns The pool transport.
 */
function createPoolTransport(endpointTransports: readonly RpcTransport[]) {
  const lastFailedAt = endpointTransports.map(() => Number.NEGATIVE_INFINITY);
  return async <TResponse>(rpcRequest: Parameters<RpcTransport>[0]): Promise<TResponse> => {
    const isSend =
      isJsonRpcPayload(rpcRequest.payload) && rpcRequest.payload.method === "sendTransaction";
    const attemptOrder = endpointAttemptOrder(lastFailedAt, Date.now());
    for (let attempt = 0; ; attempt += 1) {
      const endpointIndex = attemptOrder[attempt];
      const isLastEndpoint = attempt === attemptOrder.length - 1;
      let response: TResponse;
      try {
        response = await endpointTransports[endpointIndex]<TResponse>(rpcRequest);
      } catch (error) {
        if (rpcRequest.signal?.aborted) throw error;
        const isUnsent = error instanceof UnsentRequestError;
        const isEndpointFailure = isUnsent || isTransientRpcError(error);
        if (isEndpointFailure) lastFailedAt[endpointIndex] = Date.now();
        if (!isLastEndpoint && (isUnsent || (isEndpointFailure && !isSend))) continue;
        throw error instanceof UnsentRequestError ? error.cause : error;
      }
      if (!isSend && !isLastEndpoint && asksForAnotherEndpoint(response)) {
        lastFailedAt[endpointIndex] = Date.now();
        continue;
      }
      return response;
    }
  };
}

/** One configured endpoint of a cluster's managed pool. */
export interface ManagedRpcEndpoint {
  providerId: OrganizationRpcProvider;
  endpointUrl: string;
}

/**
 * The configured endpoints of `cluster`'s managed pool, in failover order.
 *
 * @param cluster - The cluster whose pool to read.
 * @returns One entry per non-empty `SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL` value.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
export function managedRpcEndpoints(cluster: SolanaCluster): ManagedRpcEndpoint[] {
  const endpoints = MANAGED_RPC_FAILOVER_ORDER.flatMap((providerId) => {
    const endpointUrl = process.env[MANAGED_RPC_ENV_KEYS[cluster][providerId]];
    return endpointUrl ? [{ providerId, endpointUrl }] : [];
  });
  if (endpoints.length === 0) {
    throw new SdpRpcError("RPC_NOT_CONFIGURED", `No RPC endpoint is configured for ${cluster}`, {
      cluster,
    });
  }
  return endpoints;
}

/**
 * The configured endpoint URLs for `cluster`, in failover order.
 *
 * @param cluster - The cluster whose pool to read.
 * @returns Every non-empty `SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL` value.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
function managedEndpointUrls(cluster: SolanaCluster): string[] {
  return managedRpcEndpoints(cluster).map((endpoint) => endpoint.endpointUrl);
}

/**
 * One pool endpoint's transport: kit's default HTTP transport with the read socket retry,
 * wrapped in the genesis guard, wrapped in the per-attempt deadline. Both doors build their
 * endpoints here so the wrapper order is the same for every endpoint.
 *
 * @param cluster - The cluster the endpoint must serve, checked by the genesis guard.
 * @param endpointUrl - The endpoint's URL; never logged or put in an error.
 * @returns The guarded transport for the endpoint.
 */
function guardedEndpointTransport(cluster: SolanaCluster, endpointUrl: string): RpcTransport {
  return withAttemptDeadline(
    withGenesisGuard(
      withReadSocketRetry(createDefaultRpcTransport({ url: endpointUrl })),
      cluster,
      endpointUrl
    ),
    DEFAULT_RPC_REQUEST_TIMEOUT_MS
  );
}

/**
 * The open cluster scope's pool transport: failover across the cluster's managed endpoints, each
 * behind the per-attempt deadline, read socket retry and genesis guard. Memoized per process by
 * cluster and pool, so every client on a pool shares one failover and cooldown state.
 *
 * @returns The pool key and its transport.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
function clusterPool(): { poolKey: string; poolTransport: RpcTransport } {
  const { cluster } = currentClusterScope();
  const endpointUrls = managedEndpointUrls(cluster);
  const poolKey = `${cluster} ${endpointUrls.join(" ")}`;
  const memoizedPoolTransport = clusterPoolTransports.get(poolKey);
  if (memoizedPoolTransport) return { poolKey, poolTransport: memoizedPoolTransport };
  const poolTransport = createPoolTransport(
    endpointUrls.map((endpointUrl) => guardedEndpointTransport(cluster, endpointUrl))
  );
  clusterPoolTransports.set(poolKey, poolTransport);
  return { poolKey, poolTransport };
}

/**
 * The Solana RPC client for the open cluster scope, over that cluster's managed provider pool
 * with per-request failover, a per-attempt deadline, and a genesis guard on every endpoint.
 * Memoized per process by cluster and pool, so every caller on a cluster shares one client;
 * nothing below the client may read the cluster scope. Callers needing a tighter deadline pass
 * `abortSignal` to `.send()`.
 *
 * @returns The RPC client for the scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
export function createClusterRpc(): SolanaRpc {
  const { poolKey, poolTransport } = clusterPool();
  const memoizedRpc = clusterRpcs.get(poolKey);
  if (memoizedRpc) return memoizedRpc;
  const rpc = createSolanaRpcFromTransport(poolTransport);
  clusterRpcs.set(poolKey, rpc);
  return rpc;
}

/**
 * A client for the open cluster scope to hand to code that sends without an `abortSignal`, such
 * as a chain SDK: every request is bounded end to end by `timeoutMs` (failover hops included) and
 * honours the caller's minimum-slot read scope (`withMinimumRpcSlot`). Shares the scope's pool, so
 * failover, cooldowns and genesis proofs are the same as `createClusterRpc()`'s. Memoized per
 * process by deadline, cluster and pool; below the client only the caller's read scope is read, at
 * request time, never the cluster scope.
 *
 * @param options - The client's behaviour.
 * @param options.timeoutMs - The end-to-end deadline for each request.
 * @returns The bounded RPC client for the scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
export function createClusterBoundedRpc(options: ClusterRpcOptions): SolanaRpc {
  const { poolKey, poolTransport } = clusterPool();
  const clientKey = `${options.timeoutMs} ${poolKey}`;
  const memoizedRpc = clusterBoundedRpcs.get(clientKey);
  if (memoizedRpc) return memoizedRpc;
  const rpc = createSolanaRpcFromTransport(
    withAttemptDeadline(withRpcReadContext(poolTransport), options.timeoutMs)
  );
  clusterBoundedRpcs.set(clientKey, rpc);
  return rpc;
}

/**
 * The read client for the open cluster scope: `createClusterBoundedRpc`'s deadline and read scope
 * over in-flight read sharing (`withInFlightReadSharing`), so concurrent identical reads on the
 * cluster go out once. For position and balance reads only, never to build a transaction: a
 * joined read can predate the joiner by up to the join window. One sharing transport per cluster
 * pool serves every deadline, so a share is keyed by cluster and request.
 *
 * @param options - The client's behaviour.
 * @param options.timeoutMs - The end-to-end deadline for each request, per caller.
 * @returns The read client for the scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
export function createClusterReadRpc(options: ClusterRpcOptions): SolanaRpc {
  const { poolKey, poolTransport } = clusterPool();
  const clientKey = `${options.timeoutMs} ${poolKey}`;
  const memoizedRpc = clusterReadRpcs.get(clientKey);
  if (memoizedRpc) return memoizedRpc;
  let sharedReadTransport = clusterSharedReadTransports.get(poolKey);
  if (!sharedReadTransport) {
    sharedReadTransport = withInFlightReadSharing(poolTransport);
    clusterSharedReadTransports.set(poolKey, sharedReadTransport);
  }
  const rpc = createSolanaRpcFromTransport(
    withAttemptDeadline(withRpcReadContext(sharedReadTransport), options.timeoutMs)
  );
  clusterReadRpcs.set(clientKey, rpc);
  return rpc;
}

/**
 * JSON text for a response the door's transport decoded: kit's Solana HTTP transport parses every
 * integer as a bigint, so each one is written back as the bare integer it was on the wire. Same
 * value-object round trip as kit's own (unexported) `stringifyJsonWithBigInts`.
 *
 * @param value - The decoded JSON-RPC response.
 * @returns The response as JSON text, integers at full precision.
 */
function jsonTextWithBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    typeof member === "bigint" ? { $n: member.toString() } : member
  ).replace(/\{\s*"\$n"\s*:\s*"(-?\d+)"\s*\}/g, "$1");
}

/**
 * Parse a JSON-RPC request body, keeping every integer beyond `Number.MAX_SAFE_INTEGER` exact: the
 * reviver reads the integer's source text and returns a bigint, which kit's transport writes back
 * as the bare integer. Safe integers and every other value parse as `JSON.parse` would.
 *
 * @param jsonText - The request body.
 * @returns The parsed body, large integers as bigints.
 */
function parseJsonWithLargeIntegers(jsonText: string): unknown {
  return JSON.parse(jsonText, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value
  );
}

/**
 * A `fetch` for a JSON-RPC client that can only dial a URL (a web3.js `Connection`): it ignores
 * the URL it is called with and sends the JSON-RPC body through the open cluster scope's managed
 * pool, so the genesis guard, failover and cooldowns are the same as `createClusterRpc()`'s, and
 * each request is bounded end to end by `timeoutMs`. Transport failures reject, as a failed
 * `fetch` does; every answered request is an HTTP 200 carrying the JSON-RPC response. The
 * caller's read scope (`withRpcReadContextFetch`) and any request sharing go above it. Memoized
 * per process by deadline, cluster and pool.
 *
 * @param options - The fetch's behaviour.
 * @param options.timeoutMs - The end-to-end deadline for each request.
 * @returns The fetch for the scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
export function createClusterJsonRpcFetch(options: ClusterRpcOptions): typeof fetch {
  const { poolKey, poolTransport } = clusterPool();
  const clientKey = `${options.timeoutMs} ${poolKey}`;
  const memoizedFetch = clusterJsonRpcFetches.get(clientKey);
  if (memoizedFetch) return memoizedFetch;
  const boundedTransport = withAttemptDeadline(poolTransport, options.timeoutMs);
  const jsonRpcFetch: typeof fetch = async (_input, init) => {
    if (typeof init?.body !== "string") {
      throw new TypeError("The cluster JSON-RPC fetch sends only a JSON string body");
    }
    const payload = parseJsonWithLargeIntegers(init.body);
    const response = await boundedTransport<unknown>({
      payload,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    return new Response(jsonTextWithBigInts(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  clusterJsonRpcFetches.set(clientKey, jsonRpcFetch);
  return jsonRpcFetch;
}

/**
 * Send a DAS call's one argument as the JSON-RPC `params` object: DAS methods take named
 * params, and kit's JSON-RPC API sends the argument list as a positional array.
 *
 * @param request - The request kit built from the call.
 * @returns The request with `params` set to the call's argument.
 * @throws SdpRpcError `SOLANA_RPC_ERROR` when the call didn't pass exactly one argument.
 */
function toNamedParamsRequest<TParams>(request: RpcRequest<TParams>): RpcRequest {
  const callArguments: unknown = request.params;
  if (!Array.isArray(callArguments) || callArguments.length !== 1) {
    throw solanaRpcError(`DAS method ${request.methodName} takes exactly one params object`);
  }
  const namedParams: unknown = callArguments[0];
  return { methodName: request.methodName, params: namedParams };
}

/**
 * A DAS JSON-RPC response's `result`, or kit's typed error for its `error`. No bigint upcast:
 * DAS amounts stay as the JSON numbers and strings Helius sends.
 *
 * @param response - The decoded JSON-RPC response.
 * @returns The response's `result`.
 * @throws SolanaError mapped from the response's JSON-RPC `error`.
 * @throws SdpRpcError `SOLANA_RPC_ERROR` when the body is neither a result nor an error.
 */
function toDasResult(response: RpcResponse): RpcResponse {
  if (typeof response === "object" && response !== null) {
    if ("error" in response) throw getSolanaErrorFromJsonRpcError(response.error);
    if ("result" in response) return response.result;
  }
  throw solanaRpcError("A DAS response carried neither a result nor an error");
}

/**
 * The Helius DAS client for the open cluster scope, over that cluster's
 * `SOLANA_RPC_HELIUS_<CLUSTER>_API_KEY_URL`, with the per-attempt deadline, read socket retry
 * and genesis guard every pool endpoint gets. Only Helius serves DAS, so the pool holds that
 * one endpoint: it never fails over, and only unwraps a failed genesis probe to its own error.
 * Memoized per process by cluster and URL; the URL is never returned or logged.
 *
 * @returns The DAS client for the scope's cluster, or `null` when the cluster has no Helius
 *   URL configured (DAS is then unavailable).
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 */
export function createClusterDasRpc(): DasRpc | null {
  const { cluster } = currentClusterScope();
  const heliusUrl = process.env[MANAGED_RPC_ENV_KEYS[cluster].helius];
  if (!heliusUrl) return null;
  const dasRpcKey = `${cluster} ${heliusUrl}`;
  const memoizedDasRpc = clusterDasRpcs.get(dasRpcKey);
  if (memoizedDasRpc) return memoizedDasRpc;
  const dasRpc = createRpc({
    api: createJsonRpcApi<DasApi>({
      requestTransformer: toNamedParamsRequest,
      responseTransformer: toDasResult,
    }),
    transport: createPoolTransport([guardedEndpointTransport(cluster, heliusUrl)]),
  });
  clusterDasRpcs.set(dasRpcKey, dasRpc);
  return dasRpc;
}
