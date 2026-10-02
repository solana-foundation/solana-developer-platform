import { readFloor, readStamp, withRpcReadContext } from "@sdp/rpc/read-context";
import { withReadSocketRetry } from "@sdp/rpc/solana";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";

/**
 * Maximum time a single Veda RPC request may hold a worker open.
 *
 * Applied at the TRANSPORT boundary, not only to the reads this package issues
 * directly: `@vedatech/svm-sdk` receives this same client, so its vault, asset,
 * oracle, mint and position reads are bounded too. A deposit build fans out
 * over several of those, and an unbounded one would let a slow node hold an API
 * worker for as long as it liked.
 */
export const VEDA_RPC_REQUEST_TIMEOUT_MS = 30_000;

/** Provider deadline combined with the shared confirmation context. */
export function withVedaRpcTimeout(
  transport: RpcTransport,
  timeoutMs = VEDA_RPC_REQUEST_TIMEOUT_MS
): RpcTransport {
  const scopedTransport = withRpcReadContext(transport);
  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const controller = new AbortController();
    // A distinct reason lets the catch path tell our deadline from a caller
    // cancellation even if both signals abort before the transport rejects.
    const deadlineReason = new Error("Veda RPC deadline elapsed");
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
        throw new Error(`Veda RPC request timed out after ${timeoutMs}ms`, { cause });
      }
      throw cause;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * The raw transport plus one re-send of a read whose pooled socket died before
 * any response. Every other layer sits above it, so the re-send carries the
 * payload the read context prepared.
 */
function vedaTransport(rpcUrl: string): RpcTransport {
  return withReadSocketRetry(createDefaultRpcTransport({ url: rpcUrl }));
}

/** One deadline-aware RPC client shared by this package and the pinned SDK. */
export function createVedaRpc(rpcUrl: string, timeoutMs = VEDA_RPC_REQUEST_TIMEOUT_MS) {
  return createSolanaRpcFromTransport(withVedaRpcTimeout(vedaTransport(rpcUrl), timeoutMs));
}

/** How long a read client reuses one slot's block time. */
export const VEDA_BLOCK_TIME_TTL_MS = 60_000;
const VEDA_BLOCK_TIME_CAPACITY = 256;

/**
 * The reads a position read sends, and the only methods the read transport
 * shares. Anything else, above all a send, a simulation or a blockhash, always
 * goes out as its own request.
 */
const VEDA_SHARED_READ_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBlockTime",
  "getMultipleAccounts",
  "getProgramAccounts",
]);

interface InFlightRead {
  /** `readStamp()` taken before the request was sent. */
  stamp: number;
  response: Promise<unknown>;
  consumers: number;
  controller: AbortController;
}

/**
 * De-duplication for the long-lived position-read client only.
 *
 * The SDK re-reads vault state inside every public method and follows every
 * `getMultipleAccounts` with a `getBlockTime` for the slot that served it. Two
 * de-duplications remove those repeats without changing what any caller sees:
 *
 * - A read identical (method and params) to one already in flight shares that
 *   request's response. Kit's coalescer covers one microtask only, and the SDK
 *   is several awaits deep before it sends. Only `VEDA_SHARED_READ_METHODS`
 *   are ever shared.
 * - A slot's block time is a fact of that slot, so a non-null answer is reused
 *   for a short window. Errors and nulls are never remembered.
 *
 * Applied BELOW `withRpcReadContext`: the key already carries any
 * `minContextSlot` a scoped read adds, and every consumer still validates the
 * returned context itself. A consumer whose signal aborts rejects with its own
 * reason; the shared request aborts only once every consumer has left. A caller
 * under a read floor (`withReadFloor`) joins only a request sent after the
 * floor was stamped; an older entry is replaced, and its joiners keep their
 * response.
 */
export function withVedaReadDeduplication(transport: RpcTransport): RpcTransport {
  const inFlight = new Map<string, InFlightRead>();
  const blockTimes = new Map<string, { response: unknown; expiresAt: number }>();

  const remember = (key: string, response: unknown) => {
    blockTimes.delete(key);
    blockTimes.set(key, { response, expiresAt: Date.now() + VEDA_BLOCK_TIME_TTL_MS });
    while (blockTimes.size > VEDA_BLOCK_TIME_CAPACITY) {
      const oldest = blockTimes.keys().next().value;
      if (oldest === undefined) break;
      blockTimes.delete(oldest);
    }
  };

  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const request = jsonRpcRequest(config.payload);
    if (!request || !VEDA_SHARED_READ_METHODS.has(request.method)) {
      return transport<TResponse>(config);
    }
    const key = stableKey([request.method, request.params]);

    const remembered = blockTimes.get(key);
    if (remembered && remembered.expiresAt > Date.now()) return remembered.response as TResponse;
    if (remembered) blockTimes.delete(key);

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
      created.response.then(
        (response) => {
          if (inFlight.get(key) === created) inFlight.delete(key);
          if (request.method === "getBlockTime" && isBlockTimeAnswer(response)) {
            remember(key, response);
          }
        },
        () => {
          if (inFlight.get(key) === created) inFlight.delete(key);
        }
      );
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

function isBlockTimeAnswer(response: unknown): boolean {
  if (response === null || typeof response !== "object") return false;
  const envelope = response as { error?: unknown; result?: unknown };
  return (
    envelope.error === undefined &&
    (typeof envelope.result === "bigint" || typeof envelope.result === "number")
  );
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

/**
 * The position-read client: the same deadline and confirmation context as
 * `createVedaRpc`, over the de-duplicating transport. Never used to build. The
 * socket re-send sits below the de-duplication, so one re-send serves every
 * consumer of a shared read.
 */
export function createVedaReadRpc(rpcUrl: string, timeoutMs = VEDA_RPC_REQUEST_TIMEOUT_MS) {
  const transport = withVedaReadDeduplication(vedaTransport(rpcUrl));
  return createSolanaRpcFromTransport(withVedaRpcTimeout(transport, timeoutMs));
}
