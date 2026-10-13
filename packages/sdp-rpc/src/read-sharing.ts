import { isJsonRpcPayload, type RpcTransport } from "@solana/kit";
import { readFloor, readStamp } from "./read-context";

/**
 * The reads the sharing transport shares. Every other method, above all a send, a simulation or
 * a blockhash, always goes out as its own request.
 */
const SHARED_READ_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBlockTime",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getSlot",
  "getTokenAccountsByOwner",
]);

/**
 * How long after its send a shared read may still be joined. Identical reads in one burst arrive
 * within milliseconds; an older request may have stalled, so a later caller sends its own.
 */
export const SHARED_READ_JOIN_WINDOW_MS = 2_000;

/** How long one slot's block time is reused once a node answered it. */
export const SHARED_BLOCK_TIME_TTL_MS = 60_000;

/** Most slot block times remembered at once per sharing transport. */
const SHARED_BLOCK_TIME_CAPACITY = 256;

type InFlightRead = {
  stamp: number;
  sentAt: number;
  response: Promise<unknown>;
  consumers: number;
  controller: AbortController;
};

type RememberedBlockTime = { response: unknown; expiresAt: number };

/**
 * A process-wide transport for concurrent reads that shares one in-flight response among
 * identical reads (same method and params, `SHARED_READ_METHODS` only): kit's coalescer covers one
 * microtask, while SDKs are several awaits deep before they send. A slot's block time is a fact of
 * that slot, so a numeric answer is reused for `SHARED_BLOCK_TIME_TTL_MS`; errors and nulls are
 * never remembered. Nothing else outlives its request: an entry is dropped when it settles.
 *
 * Belongs BELOW the read context, so a key carries any `minContextSlot` a scoped read adds and
 * every consumer still validates the returned context itself. A consumer whose signal aborts
 * rejects with its own reason; the shared request aborts only once every consumer has left. A
 * caller joins only a request stamped after its read floor (`withReadFloor`) and sent less than
 * `SHARED_READ_JOIN_WINDOW_MS` ago, so a stalled request never captures later callers; an older
 * entry is replaced, and its joiners keep their response. The maps live in this transport, so one
 * sharing transport per cluster pool keys every entry by cluster and request.
 *
 * @param transport - The transport the shared requests go out on.
 * @returns The sharing transport.
 */
export function withInFlightReadSharing(transport: RpcTransport): RpcTransport {
  const inFlight = new Map<string, InFlightRead>();
  const blockTimes = new Map<string, RememberedBlockTime>();

  const rememberBlockTime = (requestKey: string, response: unknown) => {
    blockTimes.delete(requestKey);
    blockTimes.set(requestKey, { response, expiresAt: Date.now() + SHARED_BLOCK_TIME_TTL_MS });
    while (blockTimes.size > SHARED_BLOCK_TIME_CAPACITY) {
      const oldestKey = blockTimes.keys().next().value;
      if (oldestKey === undefined) break;
      blockTimes.delete(oldestKey);
    }
  };

  return async <TResponse>(rpcRequest: Parameters<RpcTransport>[0]) => {
    const { payload } = rpcRequest;
    if (!isJsonRpcPayload(payload) || !SHARED_READ_METHODS.has(payload.method)) {
      return transport<TResponse>(rpcRequest);
    }
    const requestKey = stableRequestKey([payload.method, payload.params]);

    const rememberedBlockTime = blockTimes.get(requestKey);
    if (rememberedBlockTime && rememberedBlockTime.expiresAt > Date.now()) {
      return asTransportResponse<TResponse>(Promise.resolve(rememberedBlockTime.response));
    }
    if (rememberedBlockTime) blockTimes.delete(requestKey);

    const callerFloor = readFloor();
    let entry = inFlight.get(requestKey);
    if (
      entry &&
      ((callerFloor !== undefined && entry.stamp <= callerFloor) ||
        Date.now() - entry.sentAt >= SHARED_READ_JOIN_WINDOW_MS)
    ) {
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      const created: InFlightRead = {
        stamp: readStamp(),
        sentAt: Date.now(),
        response: transport<unknown>({ ...rpcRequest, signal: controller.signal }),
        consumers: 0,
        controller,
      };
      created.response.then(
        (response) => {
          if (inFlight.get(requestKey) === created) inFlight.delete(requestKey);
          if (payload.method === "getBlockTime" && isBlockTimeAnswer(response)) {
            rememberBlockTime(requestKey, response);
          }
        },
        () => {
          if (inFlight.get(requestKey) === created) inFlight.delete(requestKey);
        }
      );
      inFlight.set(requestKey, created);
      entry = created;
    }
    const joined = entry;
    return asTransportResponse<TResponse>(
      consumeSharedRead(joined, rpcRequest.signal, () => {
        if (inFlight.get(requestKey) === joined) inFlight.delete(requestKey);
      })
    );
  };
}

/**
 * Re-label a shared response as the joining caller's `TResponse`. Kit's `RpcTransport` is generic
 * per call, while one shared response serves callers with different type parameters; the runtime
 * value is the same decoded JSON-RPC body either way.
 *
 * @param response - The shared response.
 * @returns The same promise, typed for the caller.
 */
function asTransportResponse<TResponse>(response: Promise<unknown>): Promise<TResponse> {
  return response as Promise<TResponse>;
}

/**
 * Join `entry` as one more consumer, leaving it when `signal` aborts.
 *
 * @param entry - The shared in-flight read.
 * @param signal - The consumer's own signal, when it has one.
 * @param forget - Drops `entry` from the in-flight map; runs before the last consumer's abort, so
 *   a later identical request starts afresh instead of joining one about to reject with somebody
 *   else's reason.
 * @returns The shared response, or a rejection with the consumer's own abort reason.
 */
function consumeSharedRead(
  entry: InFlightRead,
  signal: AbortSignal | undefined,
  forget: () => void
): Promise<unknown> {
  entry.consumers += 1;
  const leave = (reason: unknown) => {
    entry.consumers -= 1;
    if (entry.consumers === 0) {
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

/**
 * Whether a JSON-RPC response carries a block time: no error, and a numeric result.
 *
 * @param response - The decoded JSON-RPC response.
 * @returns `true` when the response may be remembered for its slot.
 */
function isBlockTimeAnswer(response: unknown): boolean {
  if (response === null || typeof response !== "object") return false;
  if ("error" in response && response.error !== undefined) return false;
  if (!("result" in response)) return false;
  return typeof response.result === "bigint" || typeof response.result === "number";
}

/**
 * JSON with sorted object keys and tagged bigints, so equal requests always produce one key.
 *
 * @param value - The method and params to key.
 * @returns The request key.
 */
function stableRequestKey(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return { $bigint: item.toString() };
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item).sort(([leftKey], [rightKey]) =>
          leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
        )
      );
    }
    return item;
  });
}
