import { readFloor, readStamp, withRpcReadContext } from "@sdp/rpc/read-context";
import { withReadSocketRetry } from "@sdp/rpc/solana";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";

/**
 * Maximum time a single Kamino RPC request may hold a worker open.
 *
 * This deadline is applied at the transport boundary, not only to the reads
 * this package issues directly. klend-sdk receives the same RPC client, so its
 * vault, reserve, farm and exchange-rate reads are bounded too.
 */
export const KAMINO_RPC_REQUEST_TIMEOUT_MS = 30_000;

/** Provider deadline combined with the shared confirmation context. */
export function withKaminoRpcTimeout(
  transport: RpcTransport,
  timeoutMs = KAMINO_RPC_REQUEST_TIMEOUT_MS
): RpcTransport {
  const scopedTransport = withRpcReadContext(transport);
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const controller = new AbortController();
    // A distinct reason lets the catch path tell our deadline from a caller
    // cancellation even if both signals become aborted before transport rejects.
    const deadlineReason = new Error("Kamino RPC deadline elapsed");
    const timer = setTimeout(() => controller.abort(deadlineReason), timeoutMs);
    const signal = config.signal
      ? AbortSignal.any([config.signal, controller.signal])
      : controller.signal;
    try {
      return await scopedTransport<TResponse>({ ...config, signal });
    } catch (cause) {
      if (signal.aborted && signal.reason === deadlineReason) {
        // "timed out" deliberately matches the API's transient-error
        // classifier: a deadline is retryable, never a permanent vault fact.
        throw new Error(`Kamino RPC request timed out after ${timeoutMs}ms`, { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * One deadline-aware RPC client shared by the package and the pinned SDK. A
 * read whose pooled socket died before any response is re-sent once.
 */
export function createKaminoRpc(rpcUrl: string, timeoutMs = KAMINO_RPC_REQUEST_TIMEOUT_MS) {
  const transport = withReadSocketRetry(createDefaultRpcTransport({ url: rpcUrl }));
  return createSolanaRpcFromTransport(withKaminoRpcTimeout(transport, timeoutMs));
}

interface InFlightRead {
  /** `readStamp()` taken before the request was sent. */
  stamp: number;
  response: Promise<unknown>;
  consumers: number;
  controller: AbortController;
}

/** The reads a position page sends. Every other method is never shared. */
const SHARED_READ_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getSlot",
  "getTokenAccountsByOwner",
]);

/**
 * Shares one in-flight response among identical reads (same method and
 * params, `SHARED_READ_METHODS` only), so owners hydrated together read a
 * vault, its reserves and the page slot once. Nothing outlives the request: an
 * entry is dropped when it settles, so every later read is live.
 *
 * Applied BELOW `withRpcReadContext`: the key carries any `minContextSlot` a
 * scoped read adds, and every consumer still validates the returned context
 * itself. A consumer whose signal aborts rejects with its own reason; the
 * shared request aborts only once every consumer has left. A caller under a
 * read floor (`withReadFloor`) joins only a request sent after the floor was
 * stamped; an older entry is replaced, and its joiners keep their response.
 */
export function withKaminoReadDeduplication(transport: RpcTransport): RpcTransport {
  const inFlight = new Map<string, InFlightRead>();
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const request = jsonRpcRequest(config.payload);
    if (!request || !SHARED_READ_METHODS.has(request.method)) return transport<TResponse>(config);
    const key = stableKey([request.method, request.params]);
    const floor = readFloor();
    let entry = inFlight.get(key);
    if (entry && floor !== undefined && entry.stamp <= floor) entry = undefined;
    if (!entry) {
      const controller = new AbortController();
      const created: InFlightRead = {
        stamp: readStamp(),
        response: transport<unknown>({ ...config, signal: controller.signal }),
        consumers: 0,
        controller,
      };
      const forget = () => {
        if (inFlight.get(key) === created) inFlight.delete(key);
      };
      created.response.then(forget, forget);
      inFlight.set(key, created);
      entry = created;
    }
    const joined = entry;
    return consume(joined, config.signal, () => {
      if (inFlight.get(key) === joined) inFlight.delete(key);
    }) as Promise<TResponse>;
  };
}

function consume(
  entry: InFlightRead,
  signal: AbortSignal | undefined,
  forget: () => void
): Promise<unknown> {
  entry.consumers += 1;
  const leave = (reason: unknown) => {
    entry.consumers -= 1;
    if (entry.consumers === 0) {
      // Forget first, so a later identical request starts afresh instead of
      // joining a request that is about to reject with somebody else's reason.
      forget();
      entry.controller.abort(reason);
    }
  };
  if (!signal) return entry.response;
  if (signal.aborted) {
    leave(signal.reason);
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      leave(signal.reason);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    entry.response.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function jsonRpcRequest(payload: unknown): { method: string; params: unknown } | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const { method, params } = payload as { method?: unknown; params?: unknown };
  return typeof method === "string" ? { method, params } : undefined;
}

/** JSON with sorted object keys, so equal params always produce one key. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return { $bigint: item.toString() };
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        )
      );
    }
    return item;
  });
}

const KAMINO_READ_TRANSPORT_CAPACITY = 32;
const readTransports = new Map<string, RpcTransport>();

/**
 * The position-read client: the same deadline, read context and socket retry
 * as `createKaminoRpc`, over ONE de-duplicating transport per endpoint, so
 * concurrent owner reads share identical requests. The retry sits below the
 * sharing, so a re-send serves every joiner with the scoped payload. Never
 * used to build.
 */
export function createKaminoReadRpc(rpcUrl: string, timeoutMs = KAMINO_RPC_REQUEST_TIMEOUT_MS) {
  let transport = readTransports.get(rpcUrl);
  if (!transport) {
    transport = withKaminoReadDeduplication(
      withReadSocketRetry(createDefaultRpcTransport({ url: rpcUrl }))
    );
    readTransports.set(rpcUrl, transport);
    while (readTransports.size > KAMINO_READ_TRANSPORT_CAPACITY) {
      const oldest = readTransports.keys().next().value;
      if (oldest === undefined) break;
      readTransports.delete(oldest);
    }
  }
  return createSolanaRpcFromTransport(withKaminoRpcTimeout(transport, timeoutMs));
}
