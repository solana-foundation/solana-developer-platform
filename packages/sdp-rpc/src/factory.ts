import { GENESIS_HASH_BY_CLUSTER, type SolanaCluster } from "@sdp/types/well-known-tokens";
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
import { currentClusterScope } from "./scope";
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

/** Pool key (cluster plus its endpoint URLs) to the memoized client. */
const clusterRpcs = new Map<string, SolanaRpc>();

/** Each cluster's Kora upstream: the Solana RPC that cluster's Kora simulates against. */
export const KORA_UPSTREAM_RPC_ENV_KEYS = {
  devnet: "KORA_DEVNET_RPC_URL",
  "mainnet-beta": "KORA_MAINNET_RPC_URL",
} as const satisfies Record<SolanaCluster, string>;

/**
 * Kora upstream key (cluster plus URL) to the memoized client. Kept apart from `clusterRpcs` so a
 * Kora URL that is also a pool endpoint never shares the pool's client or cooldown state.
 */
const koraUpstreamRpcs = new Map<string, SolanaRpc>();

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
  return pooledClusterRpc(cluster, managedEndpointUrls(cluster), clusterRpcs);
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
    clusterRpcs
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
  return pooledClusterRpc(cluster, [endpointUrl], koraUpstreamRpcs);
}

/**
 * One memoized pooled client per cluster and ordered endpoint list. A single endpoint is a pool
 * that never fails over; the pool transport still unwraps a failed genesis probe's error.
 *
 * @param cluster - The cluster every endpoint must serve.
 * @param endpointUrls - The endpoints in failover order.
 * @param memoizedRpcs - The memo the client is kept in.
 * @returns The pooled RPC client.
 */
function pooledClusterRpc(
  cluster: SolanaCluster,
  endpointUrls: string[],
  memoizedRpcs: Map<string, SolanaRpc>
): SolanaRpc {
  const poolKey = `${cluster} ${endpointUrls.join(" ")}`;
  const memoizedRpc = memoizedRpcs.get(poolKey);
  if (memoizedRpc) return memoizedRpc;
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
  const rpc = createSolanaRpcFromTransport(createPoolTransport(endpointTransports));
  memoizedRpcs.set(poolKey, rpc);
  return rpc;
}
