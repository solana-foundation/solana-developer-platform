import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KVPutOptions, KVStore } from "@/runtime/kv";
import { rootLogger } from "@/runtime/logger";
import { createRefreshingCache } from "./refreshing-cache";

const MINUTE = 60_000;
const OPTIONS = {
  key: "test:value:v1",
  freshForMs: 60 * MINUTE,
  servableForMs: 120 * MINUTE,
  retryAfterMs: 5 * MINUTE,
  claimWaitMs: 25_000,
};

/** The slice of the KV store the cache uses, in memory: one shared store between "instances". */
function sharedStore(): KVStore {
  const values = new Map<string, string>();
  const unsupported = () => Promise.reject(new Error("not used by the cache"));
  return {
    async get(key: string, type?: "json") {
      const value = values.get(key) ?? null;
      return type === "json" && value !== null ? JSON.parse(value) : value;
    },
    async put(key: string, value: string, _options?: KVPutOptions) {
      values.set(key, value);
    },
    async delete(key: string) {
      values.delete(key);
    },
    async compareAndSet(key: string, expected: string | null, value: string) {
      if ((values.get(key) ?? null) !== expected) return false;
      values.set(key, value);
      return true;
    },
    async compareAndDelete(key: string, expected: string) {
      if (values.get(key) !== expected) return false;
      values.delete(key);
      return true;
    },
    list: unsupported,
    admitSlidingWindow: unsupported,
    // SAFETY: `get` has a JSON overload generic over its result, which no single implementation
    // can declare; this one parses JSON exactly as the Redis store does, and the cache reads only
    // the shapes it wrote.
  } as KVStore;
}

/** Lets a background refresh settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The request's background runner as the server wires it: it holds what a read hands over and,
 * like NodeBackgroundRunner, owns each task's rejection. */
let handedOver: Promise<unknown>[] = [];
const waitUntil = (promise: Promise<unknown>) => {
  handedOver.push(promise.catch(() => undefined));
};

beforeEach(() => {
  handedOver = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-13T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRefreshingCache", () => {
  it("reads the source once while the copy is fresh, and once for callers that arrive together", async () => {
    const cache = createRefreshingCache<number>(OPTIONS);
    const load = vi.fn(async () => 1);
    await expect(
      Promise.all([cache.read({ waitUntil, load }), cache.read({ waitUntil, load })])
    ).resolves.toEqual([1, 1]);
    vi.advanceTimersByTime(59 * MINUTE);
    await expect(cache.read({ waitUntil, load })).resolves.toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("answers with the stale copy at once and refreshes it once behind the scenes", async () => {
    const cache = createRefreshingCache<number>(OPTIONS);
    let version = 0;
    const load = vi.fn(async () => ++version);
    await cache.read({ waitUntil, load });
    vi.advanceTimersByTime(61 * MINUTE);
    await expect(
      Promise.all([cache.read({ waitUntil, load }), cache.read({ waitUntil, load })])
    ).resolves.toEqual([1, 1]);
    await settle();
    await expect(cache.read({ waitUntil, load })).resolves.toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("hands the refresh behind a stale copy to the request's background runner", async () => {
    const cache = createRefreshingCache<number>(OPTIONS);
    let version = 0;
    const load = vi.fn(async () => ++version);
    await cache.read({ waitUntil, load });
    // A read with nothing to serve awaits its own load.
    expect(handedOver).toHaveLength(0);

    vi.advanceTimersByTime(61 * MINUTE);
    await expect(cache.read({ waitUntil, load })).resolves.toBe(1);
    expect(handedOver).toHaveLength(1);
    // What a shutdown drains before the process exits.
    await Promise.all(handedOver);
    await expect(cache.read({ waitUntil, load })).resolves.toBe(2);
  });

  it("never stores a failure, and waits before asking a failing source again", async () => {
    const cache = createRefreshingCache<number>(OPTIONS);
    const load = vi.fn<() => Promise<number>>(async () => {
      throw new Error("down");
    });
    await expect(cache.read({ waitUntil, load })).rejects.toThrow("down");
    await expect(cache.read({ waitUntil, load })).rejects.toThrow("down");
    expect(load).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5 * MINUTE);
    load.mockResolvedValueOnce(7);
    await expect(cache.read({ waitUntil, load })).resolves.toBe(7);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good copy while refreshes fail, until it is too old to serve", async () => {
    const cache = createRefreshingCache<number>(OPTIONS);
    const load = vi.fn(async () => 1);
    await cache.read({ waitUntil, load });
    load.mockRejectedValue(new Error("down"));

    vi.advanceTimersByTime(61 * MINUTE);
    await expect(cache.read({ waitUntil, load })).resolves.toBe(1);
    await settle();
    // The failed refresh holds off the next one for retryAfterMs.
    await expect(cache.read({ waitUntil, load })).resolves.toBe(1);
    await settle();
    expect(load).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(120 * MINUTE);
    await expect(cache.read({ waitUntil, load })).rejects.toThrow("down");
  });

  it("shares one copy between instances, so a second instance never reads the source", async () => {
    const kv = sharedStore();
    const first = createRefreshingCache<number>(OPTIONS);
    const second = createRefreshingCache<number>(OPTIONS);
    const firstLoad = vi.fn(async () => 1);
    const secondLoad = vi.fn(async () => 2);

    await expect(first.read({ waitUntil, kv, load: firstLoad })).resolves.toBe(1);
    await expect(second.read({ waitUntil, kv, load: secondLoad })).resolves.toBe(1);
    expect(secondLoad).not.toHaveBeenCalled();
  });

  it("has a cold instance wait for the claimer's copy instead of reading the source too", async () => {
    const kv = sharedStore();
    const first = createRefreshingCache<number>(OPTIONS);
    const second = createRefreshingCache<number>(OPTIONS);
    let release: (value: number) => void = () => undefined;
    const slowLoad = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const otherLoad = vi.fn(async () => 3);

    const firstRead = first.read({ waitUntil, kv, load: slowLoad });
    await settle();
    const secondRead = second.read({ waitUntil, kv, load: otherLoad });
    release(2);

    await expect(firstRead).resolves.toBe(2);
    await expect(secondRead).resolves.toBe(2);
    expect(slowLoad).toHaveBeenCalledTimes(1);
    expect(otherLoad).not.toHaveBeenCalled();
  });

  it("serves another instance's fresh copy over its own recent failure", async () => {
    const kv = sharedStore();
    const first = createRefreshingCache<number>(OPTIONS);
    const second = createRefreshingCache<number>(OPTIONS);
    await first.read({ waitUntil, kv, load: async () => 1 });
    // Past servable, and the first instance's own refresh fails: it holds off reading again.
    vi.advanceTimersByTime(181 * MINUTE);
    const down = async (): Promise<number> => {
      throw new Error("down");
    };
    await expect(first.read({ waitUntil, kv, load: down })).rejects.toThrow("down");

    await expect(second.read({ waitUntil, kv, load: async () => 2 })).resolves.toBe(2);
    await expect(first.read({ waitUntil, kv, load: down })).resolves.toBe(2);
  });

  it("logs a store that fails, and answers from the source without it", async () => {
    const kv = sharedStore();
    vi.spyOn(kv, "get").mockRejectedValue(new Error("redis down"));
    const warn = vi.spyOn(rootLogger, "warn").mockImplementation(() => undefined);
    const cache = createRefreshingCache<number>(OPTIONS);

    await expect(cache.read({ waitUntil, kv, load: async () => 4 })).resolves.toBe(4);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sdp_api_refreshing_cache_store_failed",
        key: OPTIONS.key,
        call: "read",
      }),
      expect.any(String)
    );
  });

  it("stops waiting on a claimer that never stores, after its own claim wait", async () => {
    const kv = sharedStore();
    // A claimer that crashed mid-read: its claim stands, and no copy will land.
    await kv.compareAndSet(`${OPTIONS.key}:refresh`, null, "crashed-instance");
    const cache = createRefreshingCache<number>({ ...OPTIONS, claimWaitMs: 500 });
    const load = vi.fn(async () => 5);

    const startedAt = performance.now();
    await expect(cache.read({ waitUntil, kv, load })).resolves.toBe(5);
    expect(load).toHaveBeenCalledTimes(1);
    expect(performance.now() - startedAt).toBeLessThan(5_000);
  });

  it("lets only the instance holding the claim refresh a stale shared copy", async () => {
    const kv = sharedStore();
    const first = createRefreshingCache<number>(OPTIONS);
    const second = createRefreshingCache<number>(OPTIONS);
    await first.read({ waitUntil, kv, load: async () => 1 });
    vi.advanceTimersByTime(61 * MINUTE);

    let release: (value: number) => void = () => undefined;
    const slowLoad = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const otherLoad = vi.fn(async () => 3);
    await expect(first.read({ waitUntil, kv, load: slowLoad })).resolves.toBe(1);
    await settle();
    await expect(second.read({ waitUntil, kv, load: otherLoad })).resolves.toBe(1);
    await settle();
    expect(otherLoad).not.toHaveBeenCalled();

    release(2);
    await settle();
    await settle();
    second.resetForTests();
    await expect(second.read({ waitUntil, kv, load: otherLoad })).resolves.toBe(2);
    expect(slowLoad).toHaveBeenCalledTimes(1);
    expect(otherLoad).not.toHaveBeenCalled();
  });
});
