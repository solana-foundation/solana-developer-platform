/**
 * A value read from a slow or rate-sensitive source, kept warm. A fresh copy is served from
 * memory; a stale one is served at once while a single refresh runs behind it; a failed refresh
 * is retried after `retryAfterMs`, never once per request. A failure is never stored as a value.
 *
 * Given a shared `kv`, instances share one copy and one refresh: an instance adopts a newer copy
 * another stored, and only the instance holding the refresh claim reads the source while a
 * servable copy exists. The source is then read about once per `freshForMs`, whatever the
 * traffic and however many instances run. A store that fails only costs the sharing: the instance
 * carries on with its own copy and the source, and logs each failed store call.
 */
import type { KVStore } from "@/runtime/kv";
import { getLogger } from "@/runtime/logger";

export interface RefreshingCacheOptions {
  /** Names the value in the shared store; bump its version when the value's shape changes. */
  key: string;
  freshForMs: number;
  /** How long past fresh a copy is still served while a refresh runs. */
  servableForMs: number;
  retryAfterMs: number;
  /**
   * With nothing to serve, how long an instance that lost the refresh claim waits for the
   * claimer's copy before reading the source itself: just past the source read's own deadline.
   */
  claimWaitMs: number;
}

interface RefreshingCacheRead<T> {
  /** Reads the source. The first caller's `load` serves every caller waiting on it. */
  load: () => Promise<T>;
  kv?: KVStore;
  /**
   * The request's background runner (Hono's `executionCtx.waitUntil`). A refresh that runs behind
   * a stale copy outlives the response; handed over here, a shutdown drains it rather than
   * cutting it off with its shared claim still held.
   */
  waitUntil: (promise: Promise<unknown>) => void;
}

export interface RefreshingCache<T> {
  read(request: RefreshingCacheRead<T>): Promise<T>;
  /** @internal Test-only: forget the copy, any refresh in flight and any failure. */
  resetForTests(): void;
}

interface Stored<T> {
  value: T;
  storedAt: number;
}

type StoreCall = "read" | "claim" | "write" | "release";

/** A claim outlives a slow source read, then lapses so a crashed instance cannot hold it. */
const REFRESH_CLAIM_TTL_SECONDS = 60;
const CLAIMED_REFRESH_POLL_MS = 250;

/**
 * A value kept warm from its source and, given a `kv` on read, shared across instances.
 *
 * @param options - The shared store's key, how long a copy stays fresh and then servable, how
 *   long a failed read holds off the next one, and how long to wait on another instance's refresh.
 * @returns The cache; its `read` answers from memory, the shared store or the source.
 */
export function createRefreshingCache<T>(options: RefreshingCacheOptions): RefreshingCache<T> {
  const claimKey = `${options.key}:refresh`;
  const servableMs = options.freshForMs + options.servableForMs;
  let local: Stored<T> | null = null;
  let refreshing: Promise<Stored<T>> | null = null;
  let failure: { at: number; error: unknown } | null = null;

  const isFresh = (entry: Stored<T>, now: number) => now - entry.storedAt < options.freshForMs;
  const isServable = (entry: Stored<T>, now: number) => now - entry.storedAt < servableMs;

  function storeFailed(call: StoreCall, error: unknown): void {
    getLogger().warn(
      {
        event: "sdp_api_refreshing_cache_store_failed",
        key: options.key,
        call,
        error_name: error instanceof Error ? error.name : typeof error,
      },
      "refreshing cache store call failed; the instance carries on without the shared copy"
    );
  }

  async function readShared(kv: KVStore): Promise<Stored<T> | null> {
    return kv.get<Stored<T>>(options.key, "json").catch((error: unknown) => {
      storeFailed("read", error);
      return null;
    });
  }

  /** The claimer's copy once stored, or null once it gave up the claim without one or the wait ran
   * out: then the caller reads the source itself. */
  async function awaitClaimedRefresh(kv: KVStore): Promise<Stored<T> | null> {
    for (let waited = 0; waited < options.claimWaitMs; waited += CLAIMED_REFRESH_POLL_MS) {
      await new Promise((resolve) => setTimeout(resolve, CLAIMED_REFRESH_POLL_MS));
      const shared = await readShared(kv);
      if (shared && isServable(shared, Date.now())) return shared;
      const claimHeld = await kv.get(claimKey).catch((error: unknown) => {
        storeFailed("read", error);
        return null;
      });
      if (claimHeld === null) return null;
    }
    return null;
  }

  /**
   * Reads the source unless another instance holds the claim, in which case its copy (or the
   * servable one just read from the store) answers instead.
   */
  async function refresh(
    request: RefreshingCacheRead<T>,
    shared: Stored<T> | null
  ): Promise<Stored<T>> {
    const { kv } = request;
    let claim: string | null = null;
    if (kv) {
      const token = crypto.randomUUID();
      const claimed = await kv
        .compareAndSet(claimKey, null, token, { expirationTtl: REFRESH_CLAIM_TTL_SECONDS })
        .catch((error: unknown) => {
          storeFailed("claim", error);
          return true;
        });
      if (claimed) claim = token;
      else {
        const copy =
          shared && isServable(shared, Date.now()) ? shared : await awaitClaimedRefresh(kv);
        if (copy) {
          local = copy;
          return copy;
        }
      }
    }
    try {
      const entry = { value: await request.load(), storedAt: Date.now() };
      local = entry;
      failure = null;
      if (kv) {
        await kv
          .put(options.key, JSON.stringify(entry), {
            expirationTtl: Math.ceil(servableMs / 1000),
          })
          .catch((error: unknown) => storeFailed("write", error));
      }
      return entry;
    } catch (error) {
      failure = { at: Date.now(), error };
      throw error;
    } finally {
      if (kv && claim) {
        await kv
          .compareAndDelete(claimKey, claim)
          .catch((error: unknown) => storeFailed("release", error));
      }
    }
  }

  function startRefresh(
    request: RefreshingCacheRead<T>,
    shared: Stored<T> | null
  ): Promise<Stored<T>> {
    refreshing ??= refresh(request, shared).finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return {
    async read(request) {
      if (local && isFresh(local, Date.now())) return local.value;
      // Past fresh, the store may hold a newer copy from another instance: it answers before this
      // instance's own stale copy, or its last failure, would.
      const shared = request.kv ? await readShared(request.kv) : null;
      if (
        shared &&
        isServable(shared, Date.now()) &&
        (local === null || shared.storedAt > local.storedAt)
      ) {
        local = shared;
      }
      const now = Date.now();
      if (local && isFresh(local, now)) return local.value;
      const lastFailure = failure;
      const coolingDown = lastFailure !== null && now - lastFailure.at < options.retryAfterMs;
      if (local && isServable(local, now)) {
        // The stale copy answers this request either way; the refresh records its own failure,
        // which the next read reports, and the runner owns its rejection.
        if (!coolingDown) request.waitUntil(startRefresh(request, shared));
        return local.value;
      }
      if (coolingDown) throw lastFailure.error;
      return (await startRefresh(request, shared)).value;
    },
    resetForTests() {
      local = null;
      refreshing = null;
      failure = null;
    },
  };
}
