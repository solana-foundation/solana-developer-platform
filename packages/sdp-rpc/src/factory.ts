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
import { currentClusterScope } from "./scope";
import { withReadSocketRetry } from "./socket-retry";
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS, type SolanaRpc } from "./solana";
import { isTransientRpcError } from "./transient";
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

/** Pool key (cluster plus its endpoint URLs) to the memoized client. */
const clusterRpcs = new Map<string, SolanaRpc>();

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

/**
 * The configured endpoint URLs for `cluster`, in failover order.
 *
 * @param cluster - The cluster whose pool to read.
 * @returns Every non-empty `SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL` value.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
function managedEndpointUrls(cluster: SolanaCluster): string[] {
  const endpointUrls = Object.values(MANAGED_RPC_ENV_KEYS[cluster]).flatMap((envKey) => {
    const endpointUrl = process.env[envKey];
    return endpointUrl ? [endpointUrl] : [];
  });
  if (endpointUrls.length === 0) {
    throw new SdpRpcError("RPC_NOT_CONFIGURED", `No RPC endpoint is configured for ${cluster}`, {
      cluster,
    });
  }
  return endpointUrls;
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
  const { cluster } = currentClusterScope();
  const endpointUrls = managedEndpointUrls(cluster);
  const poolKey = `${cluster} ${endpointUrls.join(" ")}`;
  const memoizedRpc = clusterRpcs.get(poolKey);
  if (memoizedRpc) return memoizedRpc;
  const endpointTransports = endpointUrls.map((endpointUrl) =>
    guardedEndpointTransport(cluster, endpointUrl)
  );
  const rpc = createSolanaRpcFromTransport(createPoolTransport(endpointTransports));
  clusterRpcs.set(poolKey, rpc);
  return rpc;
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
