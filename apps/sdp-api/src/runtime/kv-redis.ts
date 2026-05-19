/**
 * Redis-backed implementation of KVStore for the Node runtime (HOO-510).
 *
 * Sister of WorkersKVStore — same surface, different backend. A single
 * ioredis client per REDIS_URL is shared across the four logical stores
 * (apiKeys / rateLimits / cache / sessions); each store namespaces its keys
 * with a prefix so list() doesn't bleed across domains.
 *
 * ioredis is loaded lazily — the top-level `import type` is erased at
 * compile time, and the real module is fetched via `await import("ioredis")`
 * inside ensureClient on first use. That keeps ioredis out of the static
 * module graph so the Cloudflare Workers test pool (miniflare) never tries
 * to transform it; otherwise miniflare's transformer chokes on ioredis's
 * debug.js with "Maximum call stack size exceeded" even when the CF branch
 * is the one that actually runs.
 *
 * Semantics note: Cloudflare KV serves stale reads for up to 60s after a key
 * expires. Redis doesn't — GET on an expired key returns null immediately.
 * Anything that accidentally relies on stale reads will surface here.
 */

import type { Redis } from "ioredis";
import type { Env } from "@/types/env";
import type { KVListResult, KVPutOptions, KVStore, KVStoreSet } from "./kv";

const SCAN_COUNT = 100;

// One Promise<Redis> per URL, shared by every RedisKVStore that points at
// that backend. Storing the Promise (not the resolved client) means that two
// concurrent first-callers wire up to the same in-flight dynamic import +
// `new Redis(...)` instead of opening parallel TCP connections.
const clientPromisesByUrl = new Map<string, Promise<Redis>>();

function ensureClient(url: string): Promise<Redis> {
  const existing = clientPromisesByUrl.get(url);
  if (existing) return existing;
  const promise = (async (): Promise<Redis> => {
    const { default: IORedis } = await import("ioredis");
    return new IORedis(url, {
      // Start the TCP handshake immediately rather than on the first command.
      // Note: ioredis does this asynchronously — an unreachable host will not
      // throw from `new IORedis(...)`; only a structurally malformed URL does.
      // Real connectivity failures surface on the first command (or via the
      // "error" event); maxRetriesPerRequest below caps the retry burst.
      lazyConnect: false,
      // Cap retry attempts per command (default is 20). With the connection
      // down, the third retry fails the command instead of trying ~20 times —
      // better signal for upstream error handling.
      maxRetriesPerRequest: 3,
    });
  })();
  clientPromisesByUrl.set(url, promise);
  // Evict on rejection so a transient malformed-URL or module-load failure
  // doesn't permanently poison the cache for the rest of the process. The
  // `===` guard avoids racing with a successful re-creation that already
  // replaced this entry.
  promise.catch(() => {
    if (clientPromisesByUrl.get(url) === promise) {
      clientPromisesByUrl.delete(url);
    }
  });
  return promise;
}

export class RedisKVStore implements KVStore {
  // Internal handle is always a Promise<Redis>. Constructor accepts a raw
  // connected client too (tests pass one for fixture-level control) and the
  // constructor normalises it via Promise.resolve — production callers go
  // through the factory and pass the cached promise from ensureClient.
  private readonly clientPromise: Promise<Redis>;
  constructor(
    client: Redis | Promise<Redis>,
    private readonly prefix: string
  ) {
    this.clientPromise = Promise.resolve(client);
  }

  private namespaced(key: string): string {
    return `${this.prefix}:${key}`;
  }

  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  async get<T>(key: string, type?: "json"): Promise<string | T | null> {
    const client = await this.clientPromise;
    const raw = await client.get(this.namespaced(key));
    if (raw === null) return null;
    if (type === "json") {
      return JSON.parse(raw) as T;
    }
    return raw;
  }

  async put(key: string, value: string, options?: KVPutOptions): Promise<void> {
    const client = await this.clientPromise;
    const namespacedKey = this.namespaced(key);
    // Ticket spec: TTL via `SET PX`. expirationTtl is seconds (parity with
    // Cloudflare KV's KVNamespacePutOptions); Redis PX expects milliseconds.
    if (options?.expirationTtl !== undefined) {
      await client.set(namespacedKey, value, "PX", options.expirationTtl * 1000);
    } else {
      // No TTL: e.g. rpc:relay:stats:* and round-robin cursor — match CF KV
      // behavior where omitting expirationTtl persists indefinitely.
      await client.set(namespacedKey, value);
    }
  }

  async delete(key: string): Promise<void> {
    const client = await this.clientPromise;
    await client.del(this.namespaced(key));
  }

  async list(): Promise<KVListResult> {
    const client = await this.clientPromise;
    const pattern = `${this.prefix}:*`;
    const stripFrom = this.prefix.length + 1; // include the trailing ":"
    const keys: { name: string }[] = [];
    let cursor = "0";
    // SCAN is non-blocking and cursor-based; iterate until the server signals
    // completion by returning "0". Callers see only unprefixed names so the
    // surface matches WorkersKVStore (test helpers clearKVNamespaces() round-
    // trip name → delete(name)).
    do {
      const [nextCursor, batch] = await client.scan(cursor, "MATCH", pattern, "COUNT", SCAN_COUNT);
      for (const namespaced of batch) {
        keys.push({ name: namespaced.slice(stripFrom) });
      }
      cursor = nextCursor;
    } while (cursor !== "0");
    return { keys };
  }
}

const STORE_PREFIXES = {
  apiKeys: "apiKeys",
  rateLimits: "rateLimits",
  cache: "cache",
  sessions: "sessions",
} as const;

/**
 * Build a KVStoreSet pointing at a shared (per-URL) ioredis client.
 *
 * Synchronous: the four returned KVStore instances hold a Promise<Redis>,
 * not a resolved client. The actual `await import("ioredis")` and `new
 * Redis(...)` happen lazily inside the first method call on any store.
 *
 * Fails fast on a missing/whitespace REDIS_URL. Graceful shutdown belongs to
 * the Node entrypoint (HOO-511); call closeAllRedisClients() from the
 * SIGTERM handler there.
 */
export function createRedisKVStoreSet(env: Env): KVStoreSet {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    throw new Error(
      "REDIS_URL missing for runtime=node. Set it in the environment (e.g. redis://localhost:6379)."
    );
  }
  const clientPromise = ensureClient(url);
  return {
    apiKeys: new RedisKVStore(clientPromise, STORE_PREFIXES.apiKeys),
    rateLimits: new RedisKVStore(clientPromise, STORE_PREFIXES.rateLimits),
    cache: new RedisKVStore(clientPromise, STORE_PREFIXES.cache),
    sessions: new RedisKVStore(clientPromise, STORE_PREFIXES.sessions),
  };
}

/**
 * Close every cached Redis client. Intended for the Node entrypoint's
 * shutdown handler (HOO-511) and for test teardown — calling it makes the
 * next createRedisKVStoreSet() open a fresh connection.
 */
export async function closeAllRedisClients(): Promise<void> {
  const promises = [...clientPromisesByUrl.values()];
  clientPromisesByUrl.clear();
  await Promise.allSettled(
    promises.map(async (promise) => {
      const client = await promise;
      await client.quit();
    })
  );
}
