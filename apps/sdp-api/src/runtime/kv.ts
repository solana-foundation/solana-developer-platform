/**
 * Runtime-neutral KV store abstraction.
 *
 * Call-sites depend on KVStore, not on Cloudflare's KVNamespace, so a
 * Redis-backed implementation (HOO-510) can drop in behind the same factory
 * without touching any consumer.
 *
 * Surface kept minimal: get / put / delete / list — only what current
 * consumers use. getWithMetadata is intentionally omitted (unused).
 */

export interface KVPutOptions {
  /** TTL in seconds. After this, get() returns null. */
  expirationTtl?: number;
}

export interface KVListKey {
  name: string;
}

export interface KVListResult {
  keys: KVListKey[];
}

export interface KVStore {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(): Promise<KVListResult>;
}

export interface KVStoreSet {
  apiKeys: KVStore;
  rateLimits: KVStore;
  cache: KVStore;
  sessions: KVStore;
}
