/**
 * Redis-backed KVStore implementation. Matches WorkersKVStore's surface
 * with a different backend. One ioredis client per REDIS_URL is shared
 * across the four logical stores (apiKeys / rateLimits / cache / sessions);
 * each store prefixes its keys so list() doesn't bleed across domains.
 *
 * ioredis is loaded lazily — the top-level `import type` is erased at emit
 * time, and the real module is fetched via `await import("ioredis")` inside
 * ensureClient on first use. That keeps ioredis out of the static module
 * graph; otherwise the Cloudflare Workers test pool (miniflare) trips on
 * ioredis's debug.js with "Maximum call stack size exceeded" during
 * transformation.
 *
 * Cloudflare KV serves stale reads for up to 60s after a key expires; Redis
 * doesn't. Anything that accidentally relied on that grace will surface.
 */

import type { Redis } from "ioredis";
import type { Env } from "@/types/env";
import type { KVListResult, KVPutOptions, KVStore, KVStoreSet } from "./kv";

const SCAN_COUNT = 100;

// One Promise<Redis> per URL, shared by every RedisKVStore at that backend.
// Storing the Promise (not the resolved client) means concurrent first-
// callers share one in-flight import + `new Redis(...)` instead of opening
// parallel sockets.
const clientPromisesByUrl = new Map<string, Promise<Redis>>();

function ensureClient(url: string): Promise<Redis> {
  const existing = clientPromisesByUrl.get(url);
  if (existing) return existing;
  const promise = (async (): Promise<Redis> => {
    const { default: IORedis } = await import("ioredis");
    return new IORedis(url, {
      // Eager TCP handshake — but ioredis does it asynchronously, so
      // unreachable hosts surface on the first command (or via the "error"
      // event), not from `new IORedis(...)`. Only a structurally malformed
      // URL throws here.
      lazyConnect: false,
      // Cap retries per command (default is 20). With the connection down,
      // the third retry fails fast — better signal for upstream error
      // handling.
      maxRetriesPerRequest: 3,
    });
  })();
  clientPromisesByUrl.set(url, promise);
  // Evict on rejection so a transient malformed-URL or module-load failure
  // doesn't permanently poison the cache. `===` guard avoids racing with a
  // successful re-creation that already replaced this entry.
  promise.catch(() => {
    if (clientPromisesByUrl.get(url) === promise) {
      clientPromisesByUrl.delete(url);
    }
  });
  return promise;
}

export class RedisKVStore implements KVStore {
  // Union accepts a raw connected client for test fixtures; Promise.resolve
  // normalizes both shapes so the rest of the class can just `await`.
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
    // expirationTtl is seconds (parity with CF KV's KVNamespacePutOptions);
    // PX expects milliseconds.
    if (options?.expirationTtl !== undefined) {
      await client.set(namespacedKey, value, "PX", options.expirationTtl * 1000);
    } else {
      // Match CF KV: omitting expirationTtl persists indefinitely.
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
    // SCAN is cursor-based and non-blocking; loop until cursor returns "0".
    // Strip the prefix on the way out so callers can round-trip list()
    // output through delete(name), matching WorkersKVStore.
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
 * Build a KVStoreSet from a shared (per-URL) ioredis client. Synchronous —
 * the stores hold a Promise<Redis>; the import and connection happen lazily
 * on the first method call. Fails fast on missing/whitespace REDIS_URL.
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
 * Close every cached Redis client. Subsequent factory calls open fresh
 * connections.
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
