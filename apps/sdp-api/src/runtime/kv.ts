/**
 * Key-value store abstraction.
 *
 * Call-sites depend on KVStore while Redis ownership and namespacing stay in
 * the runtime adapter.
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

export interface SlidingWindowOptions {
  maxRequests: number;
  previousWeight: number;
  expirationTtl: number;
}

export interface SlidingWindowAdmission {
  admitted: boolean;
  current: number;
  previous: number;
}

export interface KVStore {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Atomically replace a value only when its current value is exactly the
   * expected value. `null` means the key must not exist.
   */
  compareAndSet(key: string, expected: string | null, value: string): Promise<boolean>;
  /** Atomically delete a key only when its current value exactly matches. */
  compareAndDelete(key: string, expected: string): Promise<boolean>;
  list(): Promise<KVListResult>;
  admitSlidingWindow(
    currentKey: string,
    previousKey: string,
    options: SlidingWindowOptions
  ): Promise<SlidingWindowAdmission>;
}

export interface KVStoreSet {
  apiKeys: KVStore;
  rateLimits: KVStore;
  cache: KVStore;
}
