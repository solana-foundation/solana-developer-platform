import {
  GENESIS_HASH_BY_CLUSTER,
  SOLANA_CLUSTERS,
  type SolanaCluster,
} from "@sdp/types/well-known-tokens";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  getAbortablePromise,
  getSolanaErrorFromJsonRpcError,
  isJsonRpcPayload,
  isSolanaError,
  type RpcTransport,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_BLOCK_STATUS_NOT_AVAILABLE_YET,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_LONG_TERM_STORAGE_UNREACHABLE,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_MIN_CONTEXT_SLOT_NOT_REACHED,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_TRANSACTION_HISTORY_NOT_AVAILABLE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
} from "@solana/kit";
import { RpcTimeoutError, SdpRpcError } from "./errors";
import { MANAGED_RPC_ENV_KEYS } from "./managed-rpc-env-keys";
import { currentClusterScope, optionalClusterScope } from "./scope";
import { withReadSocketRetry } from "./socket-retry";
import { DEFAULT_RPC_REQUEST_TIMEOUT_MS, type SolanaRpc } from "./solana";
import { isTransientRpcError } from "./transient";

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
 * How long an endpoint that failed or reported itself unhealthy stays at the back of its pool's order, so
 * requests return to the preferred provider once it recovers.
 */
const ENDPOINT_COOLDOWN_MS = 30_000;

/** One family of pooled clients: they share failover and cooldown state only with each other. */
interface PoolMemo {
  /** Pool key (cluster plus its endpoint URLs in order) to the memoized pool transport. */
  readonly transports: Map<string, RpcTransport>;
  /** Pool key to the memoized client over that transport. */
  readonly rpcs: Map<string, SolanaRpc>;
}

/** The managed pools behind `createClusterRpc()`, the history client and Earn's door. */
const managedPools: PoolMemo = { transports: new Map(), rpcs: new Map() };

/**
 * `<timeoutMs> <poolKey>` to the memoized bounded Earn client. Each wraps the managed pool's own
 * transport, so a deadline never forks the pool's failover or cooldown state.
 */
const earnBoundedRpcs = new Map<string, SolanaRpc>();

/** Each cluster's Kora upstream: the Solana RPC that cluster's Kora simulates against. */
export const KORA_UPSTREAM_RPC_ENV_KEYS = {
  devnet: "KORA_DEVNET_RPC_URL",
  "mainnet-beta": "KORA_MAINNET_RPC_URL",
} as const satisfies Record<SolanaCluster, string>;

/**
 * Kora upstream clients, keyed by cluster plus URL. Kept apart from `managedPools` so a Kora URL
 * that is also a pool endpoint never shares the pool's client or cooldown state.
 */
const koraUpstreamPools: PoolMemo = { transports: new Map(), rpcs: new Map() };

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
        throw new RpcTimeoutError(timeoutMs);
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

/** One endpoint attempt: what it answered, or what it threw. */
type AttemptOutcome<TResponse> = { ok: true; response: TResponse } | { ok: false; cause: unknown };

/** What the pool does after an attempt. */
interface AttemptVerdict {
  /** Move the endpoint to the back of the order for `ENDPOINT_COOLDOWN_MS`, for every request. */
  cooldown: boolean;
  /** Ask the next endpoint, unless this was the last one. */
  tryNext: boolean;
}

/**
 * Call one endpoint, capturing a throw as an outcome so the pool judges both the same way.
 *
 * @param endpointTransport - The endpoint's guarded transport.
 * @param rpcRequest - The request to send.
 * @returns The endpoint's response, or the error it threw.
 */
async function attemptEndpoint<TResponse>(
  endpointTransport: RpcTransport,
  rpcRequest: Parameters<RpcTransport>[0]
): Promise<AttemptOutcome<TResponse>> {
  try {
    return { ok: true, response: await endpointTransport<TResponse>(rpcRequest) };
  } catch (cause) {
    return { ok: false, cause };
  }
}

/**
 * The JSON-RPC error in a response body. Nodes answer "can't serve this" with HTTP 200, and kit's
 * HTTP transport only throws on non-2xx, so the pool reads it from the body.
 *
 * @param response - The decoded JSON-RPC response.
 * @returns The served error, or `null` when the body carries none.
 */
function servedJsonRpcError(response: unknown) {
  if (typeof response !== "object" || response === null || !("error" in response)) return null;
  return getSolanaErrorFromJsonRpcError(response.error);
}

/**
 * Decide what the pool does after one attempt:
 *
 * | Attempt                                    | Cooldown | Try next |
 * | ------------------------------------------ | -------- | -------- |
 * | Caller aborted                             | no       | no       |
 * | Never sent (`UnsentRequestError`)          | yes      | yes      |
 * | `requestAirdrop` got HTTP 429              | no       | yes      |
 * | Read threw a transient error               | yes      | yes      |
 * | `sendTransaction` threw a transient error  | yes      | no       |
 * | Threw anything else                        | no       | no       |
 * | Answered "node unhealthy"                  | yes      | reads    |
 * | `sendTransaction` answered anything else   | no       | no       |
 * | `requestAirdrop` answered another error    | no       | yes      |
 * | Read answered another failover code        | no       | yes      |
 * | Read answered anything else                | no       | no       |
 *
 * A send stops once it left SDP: the failure may arrive after the leader got the transaction, and
 * resubmitting is the send primitive's decision. Only "node unhealthy" cools a node down; the other
 * `FAILOVER_JSON_RPC_ERROR_CODES` (behind the caller's `minContextSlot`, missing history or block
 * status) are about this request, not the node, and a cooldown applies to every request on the
 * cluster. An airdrop the node answered with an error did not happen, so the next provider's
 * faucet may try; the refusal is about that faucet (dry, rate-limited), not the node's health.
 * A faucet that rate-limits with HTTP 429 instead of a served error is the same refusal.
 *
 * @param outcome - The attempt's outcome.
 * @param rpcRequest - The request the attempt sent.
 * @returns Whether to cool the endpoint down and whether to try the next one.
 */
function judgeAttempt<TResponse>(
  outcome: AttemptOutcome<TResponse>,
  rpcRequest: Parameters<RpcTransport>[0]
): AttemptVerdict {
  const method = isJsonRpcPayload(rpcRequest.payload) ? rpcRequest.payload.method : null;
  const isSend = method === "sendTransaction";
  if (!outcome.ok) {
    if (rpcRequest.signal?.aborted) return { cooldown: false, tryNext: false };
    if (outcome.cause instanceof UnsentRequestError) return { cooldown: true, tryNext: true };
    if (
      method === "requestAirdrop" &&
      isSolanaError(outcome.cause, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
      outcome.cause.context.statusCode === 429
    ) {
      return { cooldown: false, tryNext: true };
    }
    if (!isTransientRpcError(outcome.cause)) return { cooldown: false, tryNext: false };
    return { cooldown: true, tryNext: !isSend };
  }
  const servedError = servedJsonRpcError(outcome.response);
  if (isSolanaError(servedError, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_NODE_UNHEALTHY)) {
    return { cooldown: true, tryNext: !isSend };
  }
  if (isSend) return { cooldown: false, tryNext: false };
  if (method === "requestAirdrop" && servedError !== null)
    return { cooldown: false, tryNext: true };
  const cannotServe = FAILOVER_JSON_RPC_ERROR_CODES.some((code) =>
    isSolanaError(servedError, code)
  );
  return { cooldown: false, tryNext: cannotServe };
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
 * Per-request failover across a cluster's endpoints: try each endpoint in `endpointAttemptOrder`
 * and let `judgeAttempt` decide whether to cool it down and whether to ask the next one. The last
 * endpoint's answer or error is returned as-is, so kit raises its typed error.
 *
 * @param endpointTransports - The guarded endpoint transports, in failover order.
 * @returns The pool transport.
 */
function createPoolTransport(endpointTransports: readonly RpcTransport[]) {
  const lastFailedAt = endpointTransports.map(() => Number.NEGATIVE_INFINITY);
  return async <TResponse>(rpcRequest: Parameters<RpcTransport>[0]): Promise<TResponse> => {
    const attemptOrder = endpointAttemptOrder(lastFailedAt, Date.now());
    // NOTE: perf. A `minContextSlot` no endpoint has reached yet walks every endpoint before the
    // last one's -32016 is returned, so a caller issuing parallel reads (wallet balances: 3) pays
    // reads × endpoints requests. Accepted for now: the floor comes from a slot SDP already saw
    // confirmed, so the full walk is rare. If it shows up, stop after two -32016 answers.
    for (let attempt = 0; ; attempt += 1) {
      const endpointIndex = attemptOrder[attempt];
      const outcome = await attemptEndpoint<TResponse>(
        endpointTransports[endpointIndex],
        rpcRequest
      );
      const verdict = judgeAttempt(outcome, rpcRequest);
      if (verdict.cooldown) lastFailedAt[endpointIndex] = Date.now();
      const isLastEndpoint = attempt === attemptOrder.length - 1;
      if (verdict.tryNext && !isLastEndpoint) continue;
      if (outcome.ok) return outcome.response;
      throw outcome.cause instanceof UnsentRequestError ? outcome.cause.cause : outcome.cause;
    }
  };
}

/**
 * The configured endpoint URLs for `cluster`, in failover order: its own managed pool or nothing,
 * never another cluster's.
 *
 * @param cluster - The cluster whose pool to read.
 * @returns Every non-empty `SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL` value, possibly none.
 */
function configuredEndpointUrls(cluster: SolanaCluster): string[] {
  return Object.values(MANAGED_RPC_ENV_KEYS[cluster]).flatMap((envKey) => {
    const endpointUrl = process.env[envKey];
    return endpointUrl ? [endpointUrl] : [];
  });
}

/**
 * The configured endpoint URLs for `cluster`, in failover order.
 *
 * @param cluster - The cluster whose pool to read.
 * @returns Every non-empty `SOLANA_RPC_<PROVIDER>_<CLUSTER>_API_KEY_URL` value.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
function managedEndpointUrls(cluster: SolanaCluster): string[] {
  const endpointUrls = configuredEndpointUrls(cluster);
  if (endpointUrls.length === 0) {
    throw new SdpRpcError("RPC_NOT_CONFIGURED", `No RPC endpoint is configured for ${cluster}`, {
      cluster,
    });
  }
  return endpointUrls;
}

/**
 * Boot check for deployments that must serve every cluster: each cluster's managed pool names at
 * least one endpoint, so `createClusterRpc()` never answers `RPC_NOT_CONFIGURED` at request time.
 *
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` naming the first cluster with no endpoint.
 */
export function assertManagedRpcConfigured(): void {
  for (const cluster of SOLANA_CLUSTERS) {
    managedEndpointUrls(cluster);
  }
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
  return pooledClusterRpc(cluster, managedEndpointUrls(cluster), managedPools);
}

/**
 * The scope's cluster client for wallet signature history: the same managed pool with the Helius
 * endpoint tried first, for its deeper `getSignaturesForAddress` history, and the other providers
 * as failover. Without a Helius endpoint it is the plain pool. Biome restricts it to observed
 * transfers, so no other caller reorders the pool.
 *
 * @returns The history RPC client for the scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster has no endpoint configured.
 */
export function createClusterHistoryRpc(): SolanaRpc {
  const { cluster } = currentClusterScope();
  const heliusUrl = process.env[MANAGED_RPC_ENV_KEYS[cluster].helius];
  const endpointUrls = managedEndpointUrls(cluster);
  return pooledClusterRpc(
    cluster,
    heliusUrl
      ? [heliusUrl, ...endpointUrls.filter((endpointUrl) => endpointUrl !== heliusUrl)]
      : endpointUrls,
    managedPools
  );
}

/**
 * The Solana RPC the open scope's cluster's Kora simulates against, for the Fee Payer's own reads
 * (fee pricing, budget reconciliation), so they never share endpoints or failover state with the
 * managed pool. One endpoint, no failover, with the pool's attempt deadline, dead-socket re-send
 * and genesis guard. Memoized per process by cluster and URL. Biome restricts it to
 * `@sdp/fee-payment`.
 *
 * @returns The Kora upstream RPC client for the scope's cluster.
 * @throws SdpRpcError `CLUSTER_SCOPE_MISSING` outside a cluster scope.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when the cluster's `KORA_<CLUSTER>_RPC_URL` is unset.
 */
export function createKoraUpstreamRpc(): SolanaRpc {
  const { cluster } = currentClusterScope();
  const envKey = KORA_UPSTREAM_RPC_ENV_KEYS[cluster];
  const endpointUrl = process.env[envKey]?.trim();
  if (!endpointUrl) {
    throw new SdpRpcError(
      "RPC_NOT_CONFIGURED",
      `No Kora upstream RPC is configured for ${cluster}: set ${envKey}`,
      { cluster }
    );
  }
  return pooledClusterRpc(cluster, [endpointUrl], koraUpstreamPools);
}

/** Behaviour options for Earn's cluster client: never a URL, which comes from the managed pool. */
export type EarnClusterRpcOptions = Readonly<{
  /**
   * End-to-end deadline for each request, failover hops and genesis probes included. Omitted, each
   * endpoint attempt keeps the pool's own deadline.
   */
  timeoutMs?: number;
}>;

/**
 * Refuse Earn work that names a cluster other than the open scope's, so an Earn request inside a
 * project scope can never read the other cluster. Outside a scope (the global Earn crons) the
 * named cluster stands.
 *
 * @param cluster - The cluster the Earn work named.
 * @throws SdpRpcError `CLUSTER_SCOPE_CONFLICT` inside a scope for the other cluster.
 */
function assertEarnClusterInScope(cluster: SolanaCluster): void {
  const openScope = optionalClusterScope();
  if (openScope === undefined || openScope.cluster === cluster) return;
  throw new SdpRpcError(
    "CLUSTER_SCOPE_CONFLICT",
    `Earn work named ${cluster} inside a ${openScope.cluster} cluster scope`,
    { openCluster: openScope.cluster, requestedCluster: cluster }
  );
}

/**
 * Earn's door to `cluster`'s managed pool. Earn still names its cluster (from the project, the
 * strategy row or the row it reconciles) until it reads the cluster scope (HOO-1881), so this is
 * `createClusterRpc()` with the cluster as an argument: without `timeoutMs` it returns the very
 * client `createClusterRpc()` returns in that cluster's scope, and with one it wraps that client's
 * pool transport, so failover, cooldowns and genesis proofs stay shared. A cluster with no managed
 * endpoint throws; nothing falls back to another cluster's pool or to a process default.
 *
 * @param cluster - The cluster the work runs on.
 * @param options - The client's behaviour.
 * @param options.timeoutMs - The end-to-end deadline for each request.
 * @returns The RPC client for `cluster`.
 * @throws SdpRpcError `CLUSTER_SCOPE_CONFLICT` inside a scope for the other cluster.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when `cluster` has no endpoint configured.
 */
export function createEarnClusterRpc(
  cluster: SolanaCluster,
  options?: EarnClusterRpcOptions
): SolanaRpc {
  assertEarnClusterInScope(cluster);
  const endpointUrls = managedEndpointUrls(cluster);
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs === undefined) return pooledClusterRpc(cluster, endpointUrls, managedPools);
  const { poolKey, poolTransport } = pooledClusterTransport(
    cluster,
    endpointUrls,
    managedPools.transports
  );
  const clientKey = `${timeoutMs} ${poolKey}`;
  const memoizedRpc = earnBoundedRpcs.get(clientKey);
  if (memoizedRpc) return memoizedRpc;
  const rpc = createSolanaRpcFromTransport(withAttemptDeadline(poolTransport, timeoutMs));
  earnBoundedRpcs.set(clientKey, rpc);
  return rpc;
}

/**
 * Earn's provider endpoints for `cluster`: its managed pool's URLs in failover order, or none,
 * never another cluster's. Earn's provider packages still build their own transports from a URL
 * and pin one endpoint per operation (ADR 0007 rejects per-request failover inside one plan), so
 * this is the one function that hands a pool URL out of `@sdp/rpc` until those packages take
 * clients (HOO-1881) and the pinning moves to `withConsistentRpcReads` (HOO-2025). Prove each URL
 * with `proveEarnClusterEndpoint` before use.
 *
 * @param cluster - The cluster the work runs on.
 * @returns The configured endpoint URLs, possibly none.
 * @throws SdpRpcError `CLUSTER_SCOPE_CONFLICT` inside a scope for the other cluster.
 */
export function earnClusterEndpointUrls(cluster: SolanaCluster): string[] {
  assertEarnClusterInScope(cluster);
  return configuredEndpointUrls(cluster);
}

/**
 * Prove `endpointUrl`, one of `cluster`'s managed endpoints, serves `cluster`, with the probe,
 * proof cache and TTL the pool's genesis guard uses: an endpoint the pool proved is proved here,
 * and the other way round, so the two never probe one endpoint twice.
 *
 * @param cluster - The cluster the endpoint must serve.
 * @param endpointUrl - One of `earnClusterEndpointUrls(cluster)`.
 * @returns Resolves once the endpoint holds an unexpired proof.
 * @throws SdpRpcError `CLUSTER_SCOPE_CONFLICT` inside a scope for the other cluster.
 * @throws SdpRpcError `RPC_NOT_CONFIGURED` when `endpointUrl` is not in `cluster`'s pool.
 * @throws SdpRpcError `RPC_CLUSTER_MISMATCH` when the endpoint serves another cluster.
 */
export async function proveEarnClusterEndpoint(
  cluster: SolanaCluster,
  endpointUrl: string
): Promise<void> {
  assertEarnClusterInScope(cluster);
  if (!configuredEndpointUrls(cluster).includes(endpointUrl)) {
    throw new SdpRpcError(
      "RPC_NOT_CONFIGURED",
      `The endpoint is not in the ${cluster} managed pool`,
      { cluster }
    );
  }
  const genesisProofKey = `${cluster} ${endpointUrl}`;
  const proofExpiresAt = genesisProofExpiry.get(genesisProofKey);
  if (proofExpiresAt !== undefined && proofExpiresAt > Date.now()) return;
  await proveGenesis(
    withReadSocketRetry(createDefaultRpcTransport({ url: endpointUrl })),
    cluster,
    genesisProofKey
  );
}

/**
 * One memoized pool transport per cluster and ordered endpoint list, within one family: every
 * endpoint behind the per-attempt deadline, read socket retry and genesis guard.
 *
 * @param cluster - The cluster every endpoint must serve.
 * @param endpointUrls - The endpoints in failover order.
 * @param memoizedTransports - The family's transport memo.
 * @returns The pool key and its transport.
 */
function pooledClusterTransport(
  cluster: SolanaCluster,
  endpointUrls: string[],
  memoizedTransports: PoolMemo["transports"]
): { poolKey: string; poolTransport: RpcTransport } {
  const poolKey = `${cluster} ${endpointUrls.join(" ")}`;
  const memoizedTransport = memoizedTransports.get(poolKey);
  if (memoizedTransport) return { poolKey, poolTransport: memoizedTransport };
  const endpointTransports = endpointUrls.map((endpointUrl) =>
    withAttemptDeadline(
      withGenesisGuard(
        withReadSocketRetry(createDefaultRpcTransport({ url: endpointUrl })),
        cluster,
        endpointUrl
      ),
      DEFAULT_RPC_REQUEST_TIMEOUT_MS
    )
  );
  const poolTransport = createPoolTransport(endpointTransports);
  memoizedTransports.set(poolKey, poolTransport);
  return { poolKey, poolTransport };
}

/**
 * One memoized pooled client per cluster and ordered endpoint list, within one family. A single
 * endpoint is a pool that never fails over; the pool transport still unwraps a failed genesis
 * probe's error.
 *
 * @param cluster - The cluster every endpoint must serve.
 * @param endpointUrls - The endpoints in failover order.
 * @param memo - The family the transport and client are kept in.
 * @returns The pooled RPC client.
 */
function pooledClusterRpc(
  cluster: SolanaCluster,
  endpointUrls: string[],
  memo: PoolMemo
): SolanaRpc {
  const { poolKey, poolTransport } = pooledClusterTransport(cluster, endpointUrls, memo.transports);
  const memoizedRpc = memo.rpcs.get(poolKey);
  if (memoizedRpc) return memoizedRpc;
  const rpc = createSolanaRpcFromTransport(poolTransport);
  memo.rpcs.set(poolKey, rpc);
  return rpc;
}
