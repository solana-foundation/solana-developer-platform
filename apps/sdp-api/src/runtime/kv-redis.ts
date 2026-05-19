/**
 * Redis-backed implementation of KVStore for the Node runtime (HOO-510).
 *
 * Sister of WorkersKVStore — same surface, different backend. Single ioredis
 * client is shared across the four logical stores (apiKeys / rateLimits /
 * cache / sessions); each store namespaces its keys with a prefix so list()
 * doesn't bleed across domains.
 *
 * Semantics note: Cloudflare KV serves stale reads for up to 60s after a key
 * expires. Redis doesn't — `GET` on an expired key returns null immediately.
 * Anything that accidentally relies on stale reads will surface here.
 */

import Redis from "ioredis";
import type { Env } from "@/types/env";
import type { KVListResult, KVPutOptions, KVStore, KVStoreSet } from "./kv";

const SCAN_COUNT = 100;

export class RedisKVStore implements KVStore {
  constructor(
    private readonly client: Redis,
    private readonly prefix: string
  ) {}

  private namespaced(key: string): string {
    return `${this.prefix}:${key}`;
  }

  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  async get<T>(key: string, type?: "json"): Promise<string | T | null> {
    const raw = await this.client.get(this.namespaced(key));
    if (raw === null) return null;
    if (type === "json") {
      return JSON.parse(raw) as T;
    }
    return raw;
  }

  async put(key: string, value: string, options?: KVPutOptions): Promise<void> {
    const namespacedKey = this.namespaced(key);
    // Ticket spec: TTL via `SET PX`. expirationTtl is seconds (parity with
    // Cloudflare KV's KVNamespacePutOptions); Redis PX expects milliseconds.
    if (options?.expirationTtl !== undefined) {
      await this.client.set(namespacedKey, value, "PX", options.expirationTtl * 1000);
    } else {
      // No TTL: e.g. rpc:relay:stats:* and round-robin cursor — match CF KV
      // behavior where omitting expirationTtl persists indefinitely.
      await this.client.set(namespacedKey, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(this.namespaced(key));
  }

  async list(): Promise<KVListResult> {
    const pattern = `${this.prefix}:*`;
    const stripFrom = this.prefix.length + 1; // include the trailing ":"
    const keys: { name: string }[] = [];
    let cursor = "0";
    // SCAN is non-blocking and cursor-based; iterate until the server signals
    // completion by returning "0". Callers see only unprefixed names so the
    // surface matches WorkersKVStore (test helpers clearKVNamespaces() round-
    // trip name → delete(name)).
    do {
      const [nextCursor, batch] = await this.client.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT
      );
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

// kvStoreMiddleware calls createKVStoreSet(c.env) on every authenticated
// request, so this factory MUST return the same ioredis client across calls
// for a given URL — otherwise each request opens a fresh TCP connection and
// nothing ever closes them, exhausting Redis's maxclients under load.
//
// Keyed by URL (not just a single `let`) so test runs that point at different
// instances don't accidentally share a client, and so a previously-quit
// client (status === "end") is detected and replaced instead of returning a
// dead handle.
const clientsByUrl = new Map<string, Redis>();

function getOrCreateClient(url: string): Redis {
  const existing = clientsByUrl.get(url);
  if (existing && existing.status !== "end") {
    return existing;
  }
  const client = new Redis(url, {
    // Start the TCP handshake immediately rather than on the first command.
    // Note: ioredis does this asynchronously — an unreachable host will not
    // throw from `new Redis(...)`; only a structurally malformed URL does.
    // Real connectivity failures surface on the first command (or via the
    // "error" event); maxRetriesPerRequest below caps how long they queue.
    lazyConnect: false,
    // Cap retry attempts per command (default is 20). With the connection
    // down, the third retry fails the command instead of trying ~20 times —
    // better signal for upstream error handling.
    maxRetriesPerRequest: 3,
  });
  clientsByUrl.set(url, client);
  return client;
}

/**
 * Build a KVStoreSet backed by a process-wide ioredis client (one per URL).
 *
 * Fails fast at factory time if REDIS_URL is missing/whitespace — the
 * alternative is a deep "ECONNREFUSED" on the first request, which is harder
 * to map back to a missing env. Graceful shutdown belongs to the Node
 * entrypoint (HOO-511); call `closeAllRedisClients()` from the SIGTERM
 * handler there.
 */
export function createRedisKVStoreSet(env: Env): KVStoreSet {
  const url = env.REDIS_URL?.trim();
  if (!url) {
    throw new Error(
      "REDIS_URL missing for runtime=node. Set it in the environment (e.g. redis://localhost:6379)."
    );
  }
  const client = getOrCreateClient(url);
  return {
    apiKeys: new RedisKVStore(client, STORE_PREFIXES.apiKeys),
    rateLimits: new RedisKVStore(client, STORE_PREFIXES.rateLimits),
    cache: new RedisKVStore(client, STORE_PREFIXES.cache),
    sessions: new RedisKVStore(client, STORE_PREFIXES.sessions),
  };
}

/**
 * Close every cached Redis client. Intended for the Node entrypoint's
 * shutdown handler (HOO-511) and for test teardown — calling it makes the
 * next createRedisKVStoreSet() open a fresh connection.
 */
export async function closeAllRedisClients(): Promise<void> {
  const clients = [...clientsByUrl.values()];
  clientsByUrl.clear();
  await Promise.allSettled(clients.map((c) => c.quit()));
}
