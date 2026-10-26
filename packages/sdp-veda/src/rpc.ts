import { AsyncLocalStorage } from "node:async_hooks";
import { readFloor, readStamp, withRpcReadContext } from "@sdp/rpc/read-context";
import { withReadSocketRetry } from "@sdp/rpc/socket-retry";
import {
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
} from "@solana/kit";
import { z } from "zod";

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
 * The reads the SDK's position, quote and build methods send, and the only
 * methods the read transport shares. Anything else, above all a send, a
 * simulation or a blockhash, always goes out as its own request.
 */
const VEDA_SHARED_READ_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getBlockTime",
  "getMultipleAccounts",
  "getProgramAccounts",
]);

/**
 * How long after its send a shared read may still be joined. Identical reads in
 * one burst arrive within milliseconds; an older request may have stalled, so a
 * later caller sends its own.
 */
export const VEDA_SHARED_READ_JOIN_WINDOW_MS = 2_000;

interface InFlightRead {
  /** `readStamp()` taken before the request was sent. */
  stamp: number;
  /** `Date.now()` when the request was sent. */
  sentAt: number;
  response: Promise<unknown>;
  consumers: number;
  controller: AbortController;
}

/** Most `getMultipleAccounts` answers one operation holds. */
const VEDA_OPERATION_HELD_CAPACITY = 16;

/**
 * A `getMultipleAccounts` an operation may hold or serve: a list of addresses
 * and the SDK's plain config, never a data slice.
 */
const heldAccountsRequestSchema = z.object({
  method: z.literal("getMultipleAccounts"),
  params: z.union([
    z.tuple([z.array(z.string())]),
    z.tuple([
      z.array(z.string()),
      z.looseObject({
        // Kit sends it as the SDK passed it, a bigint, and downcasts only on the wire.
        minContextSlot: z
          .union([z.number().int().nonnegative(), z.bigint().nonnegative()])
          .optional(),
        dataSlice: z.never().optional(),
      }),
    ]),
  ]),
});

/** A successful `getMultipleAccounts` answer: account values at one context slot. */
const heldAccountsAnswerSchema = z.looseObject({
  error: z.never().optional(),
  result: z.looseObject({
    context: z.looseObject({
      slot: z.union([z.number().int().nonnegative(), z.bigint().nonnegative()]),
    }),
    value: z.array(z.unknown()),
  }),
});

type HeldAccountsAnswer = z.infer<typeof heldAccountsAnswerSchema>;

/** One `getMultipleAccounts` answer an operation holds. */
interface HeldAccounts {
  /** `stableKey` of the request's config without `minContextSlot`. */
  config: string;
  /** The context slot that answered it. */
  slot: number;
  /** `readStamp()` of the request that answered it. */
  stamp: number;
  /** Each requested address and its position in the answer's `value`. */
  index: ReadonlyMap<string, number>;
  answer: HeldAccountsAnswer;
}

const operationReads = new AsyncLocalStorage<HeldAccounts[]>();

/**
 * Run one provider operation so it fetches each account once.
 *
 * The SDK re-reads the vault state in every public method and reads the rest of
 * an operation's accounts in several small batches, so one queue build fetched
 * the vault state 15 times. Inside this scope, a `getMultipleAccounts` whose
 * addresses all appear in an answer the SAME operation already holds, under the
 * same config and at a slot no older than its `minContextSlot`, is served from
 * that answer: exactly what the narrower request would have returned at that
 * slot, which is the one consistent snapshot the SDK's own
 * `minContextSlot: preflight.slot` re-read asks for. An operation that reads
 * every account it needs in one request first therefore sends nothing else but
 * a block time. "Live" means read once per operation, never across operations:
 * the held answers die with the scope.
 *
 * Only plain `getMultipleAccounts` is served, never a data slice, another
 * method or an error. It sits below the read context, so a scoped read's
 * minimum slot is checked against the held answer's slot, and an answer is
 * served only to a caller whose read floor it postdates. `VedaVaultDirectClient`
 * opens one per operation attempt, so a failover re-attempt starts with nothing
 * held; a nested scope joins the one already open.
 */
export function withVedaOperationReads<T>(operation: () => Promise<T>): Promise<T> {
  return operationReads.getStore() ? operation() : operationReads.run([], operation);
}

/** What an operation may hold or serve of a `getMultipleAccounts` request. */
interface AccountsRead {
  addresses: readonly string[];
  /** `stableKey` of its config without `minContextSlot`. */
  config: string;
  /** Its `minContextSlot`, when it names one. */
  minimumSlot: number | undefined;
}

function accountsRead(request: z.infer<typeof heldAccountsRequestSchema>): AccountsRead {
  const [addresses, config] = request.params;
  if (config === undefined) return { addresses, config: stableKey({}), minimumSlot: undefined };
  const { minContextSlot, ...rest } = config;
  return {
    addresses,
    config: stableKey(rest),
    minimumSlot: minContextSlot === undefined ? undefined : Number(minContextSlot),
  };
}

/** The held answer, newest slot first, that covers every requested address. */
function serveHeld(
  held: readonly HeldAccounts[],
  read: AccountsRead,
  floor: number | undefined
): HeldAccountsAnswer | undefined {
  let best: { from: HeldAccounts; value: unknown[] } | undefined;
  for (const from of held) {
    if (from.config !== read.config) continue;
    if (read.minimumSlot !== undefined && from.slot < read.minimumSlot) continue;
    if (floor !== undefined && from.stamp <= floor) continue;
    if (best && best.from.slot >= from.slot) continue;
    const value: unknown[] = [];
    for (const key of read.addresses) {
      const position = from.index.get(key);
      if (position === undefined) break;
      value.push(from.answer.result.value[position]);
    }
    if (value.length === read.addresses.length) best = { from, value };
  }
  if (!best) return undefined;
  return { ...best.from.answer, result: { ...best.from.answer.result, value: best.value } };
}

function holdAnswer(
  held: HeldAccounts[],
  read: AccountsRead,
  stamp: number,
  answer: HeldAccountsAnswer
): void {
  if (answer.result.value.length !== read.addresses.length) return;
  const index = new Map<string, number>();
  read.addresses.forEach((key, position) => {
    if (!index.has(key)) index.set(key, position);
  });
  held.push({
    config: read.config,
    slot: Number(answer.result.context.slot),
    stamp,
    index,
    answer,
  });
  while (held.length > VEDA_OPERATION_HELD_CAPACITY) held.shift();
}

/**
 * De-duplication for the long-lived shared clients (`sdk.ts`).
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
 * Inside `withVedaOperationReads`, an account read the operation already holds
 * is answered from it first.
 *
 * Applied BELOW `withRpcReadContext`: the key already carries any
 * `minContextSlot` a scoped read adds, and every consumer still validates the
 * returned context itself. A consumer whose signal aborts rejects with its own
 * reason; the shared request aborts only once every consumer has left. A caller
 * joins only a request sent after its read floor (`withReadFloor`) and less
 * than `VEDA_SHARED_READ_JOIN_WINDOW_MS` ago, so a stalled request never
 * captures later callers; an older entry is replaced, and its joiners keep
 * their response.
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

  /** An identical request sent after the caller's floor and inside the join window, or a new one. */
  const inFlightRead = (
    key: string,
    method: string,
    config: Parameters<RpcTransport>[0],
    floor: number | undefined
  ): InFlightRead => {
    const entry = inFlight.get(key);
    if (
      entry &&
      (floor === undefined || entry.stamp > floor) &&
      Date.now() - entry.sentAt < VEDA_SHARED_READ_JOIN_WINDOW_MS
    ) {
      return entry;
    }
    const controller = new AbortController();
    const created: InFlightRead = {
      stamp: readStamp(),
      sentAt: Date.now(),
      response: transport<unknown>({ ...config, signal: controller.signal }),
      consumers: 0,
      controller,
    };
    created.response.then(
      (response) => {
        if (inFlight.get(key) === created) inFlight.delete(key);
        if (method === "getBlockTime" && isBlockTimeAnswer(response)) remember(key, response);
      },
      () => {
        if (inFlight.get(key) === created) inFlight.delete(key);
      }
    );
    inFlight.set(key, created);
    return created;
  };

  /** One shared read, answered from the operation's held reads, a remembered block time, or the wire. */
  const sharedRead = async (
    key: string,
    method: string,
    config: Parameters<RpcTransport>[0]
  ): Promise<unknown> => {
    const floor = readFloor();
    const held = operationReads.getStore();
    const parsed = heldAccountsRequestSchema.safeParse(config.payload);
    const operation =
      held !== undefined && parsed.success ? { held, read: accountsRead(parsed.data) } : undefined;
    const served = operation && serveHeld(operation.held, operation.read, floor);
    if (served) {
      if (config.signal?.aborted) throw config.signal.reason;
      return served;
    }

    const remembered = blockTimes.get(key);
    if (remembered && remembered.expiresAt > Date.now()) return remembered.response;
    if (remembered) blockTimes.delete(key);

    const joined = inFlightRead(key, method, config, floor);
    const answer = await consume(joined, config.signal, () => {
      if (inFlight.get(key) === joined) inFlight.delete(key);
    });
    if (operation) {
      const heldAnswer = heldAccountsAnswerSchema.safeParse(answer);
      if (heldAnswer.success) {
        holdAnswer(operation.held, operation.read, joined.stamp, heldAnswer.data);
      }
    }
    return answer;
  };

  return async <TResponse>(config: Parameters<RpcTransport>[0]) => {
    const request = jsonRpcRequest(config.payload);
    if (!request || !VEDA_SHARED_READ_METHODS.has(request.method)) {
      return transport<TResponse>(config);
    }
    const key = stableKey([request.method, request.params]);
    // SAFETY: every shared answer is the envelope a transport returned for this
    // exact method and params, which is the response `TResponse` names.
    return (await sharedRead(key, request.method, config)) as TResponse;
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
 * The shared clients' RPC: the same deadline and confirmation context as
 * `createVedaRpc`, over the de-duplicating transport. Queue builds use it too:
 * the SDK's `build*` methods only read, and a send, a simulation or a
 * blockhash never takes a shared path. The socket re-send sits below the
 * de-duplication, so one re-send serves every consumer of a shared read.
 */
export function createVedaReadRpc(rpcUrl: string, timeoutMs = VEDA_RPC_REQUEST_TIMEOUT_MS) {
  const transport = withVedaReadDeduplication(vedaTransport(rpcUrl));
  return createSolanaRpcFromTransport(withVedaRpcTimeout(transport, timeoutMs));
}
