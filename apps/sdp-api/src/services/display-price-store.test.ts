import { randomUUID } from "node:crypto";
import { runInClusterScope } from "@sdp/rpc/scope";
import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";
import { required } from "@/test/helpers/required";
import { clearDisplayPriceCacheForTests, fetchDisplayUsdPrices } from "./display-price.service";
import { createDisplayPriceStore, RedisDisplayPriceStore } from "./display-price-store";
import type { DisplayPrice, DisplayPriceAnswer } from "./tokens-xyz-price-client";

describe("shared Tokens price coordination", () => {
  let first: Redis;
  let second: Redis;
  let prefix: string;
  let store: RedisDisplayPriceStore;
  let replica: RedisDisplayPriceStore;

  beforeAll(() => {
    first = new Redis(required(env.REDIS_URL));
    second = new Redis(required(env.REDIS_URL));
  });
  afterAll(async () => {
    await Promise.all([first.quit(), second.quit()]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearDisplayPriceCacheForTests();
  });
  beforeEach(() => {
    prefix = `test:tokens:{${randomUUID()}}`;
    store = new RedisDisplayPriceStore(Promise.resolve(first), prefix);
    replica = new RedisDisplayPriceStore(Promise.resolve(second), prefix);
  });

  function price(usdPrice: number): DisplayPrice {
    return {
      kind: "priced",
      usdPrice,
      snapshotFetchedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
  }

  async function serverNow(): Promise<number> {
    const [seconds, microseconds] = await first.time();
    return Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
  }

  it("shares state by provider key without exposing credentials in Redis", async () => {
    const apiKey = `test-tokens-${randomUUID()}`;
    const otherApiKey = `test-tokens-${randomUUID()}`;
    const keyedStore = createDisplayPriceStore(env, apiKey);
    const keyedReplica = createDisplayPriceStore(env, apiKey);
    const isolatedStore = createDisplayPriceStore(env, otherApiKey);
    const mint = randomUUID();
    const answer = new Map([[mint, price(2)]]);

    expect((await keyedStore.lookup([mint], "one")).claimed).toEqual([mint]);
    expect((await keyedReplica.lookup([mint], "two")).pending).toEqual([mint]);
    await keyedStore.complete([mint], "one", answer);
    expect((await keyedReplica.lookup([mint], null)).prices).toEqual(answer);
    expect((await isolatedStore.lookup([mint], null)).prices.size).toBe(0);

    await keyedStore.backOff();
    expect(await keyedReplica.admitRequest()).toBe(false);
    expect(await isolatedStore.admitRequest()).toBe(true);

    const keys = await first.keys(`vitest-${process.env.VITEST_POOL_ID}:sdp:display-prices:*`);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain(apiKey);
      expect(key).not.toContain(otherApiKey);
    }
  });

  it("grants each mint to one replica and shares the published answer", async () => {
    const [one, two] = await Promise.all([
      store.lookup(["A", "B"], "owner-1"),
      replica.lookup(["A", "B"], "owner-2"),
    ]);
    expect(one.claimed.length + two.claimed.length).toBe(2);
    expect(one.pending.length + two.pending.length).toBe(2);
    const owner = one.claimed.length > 0 ? "owner-1" : "owner-2";
    const answer = new Map([["A", price(2)]]);
    await store.complete(["A", "B"], owner, answer);
    const read = await replica.lookup(["A", "B"], null);
    expect(read.prices).toEqual(answer);
    expect(read.pending).toEqual([]);
    expect(await first.exists(`${prefix}:price:B`)).toBe(0);
    expect(await first.pttl(`${prefix}:price:A`)).toBeGreaterThan(59_000);
    expect(await first.pttl(`${prefix}:price:A`)).toBeLessThanOrEqual(60_000);
  });

  it("releases failed mints without remembering a missing price", async () => {
    await store.lookup(["A"], "one");
    await store.complete(["A"], "one", new Map());
    expect((await replica.lookup(["A"], "two")).claimed).toEqual(["A"]);
  });

  it("shares confirmed absences across replicas with the same bounded TTL as prices", async () => {
    await store.lookup(["A", "B"], "one");
    const answer = new Map<string, DisplayPriceAnswer>([
      ["A", { kind: "missing", expiresAt: Date.now() + 60_000 }],
      ["B", price(2)],
    ]);
    await store.complete(["A", "B"], "one", answer);

    const read = await replica.lookup(["A", "B"], "two");
    expect(read.prices).toEqual(answer);
    expect(read.claimed).toEqual([]);
    expect(read.pending).toEqual([]);
    expect(await first.pttl(`${prefix}:price:A`)).toBeGreaterThan(59_000);
    expect(await first.pttl(`${prefix}:price:A`)).toBeLessThanOrEqual(60_000);
  });

  it("reuses confirmed absences from Redis after the process cache is cleared", async () => {
    const mint = randomUUID();
    const priceEnv = { ...env, TOKENS_XYZ_API_KEY: `test-tokens-${randomUUID()}` };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json([{ address: mint, hasMarket: false, token: null }])
      );
    const lookup = () =>
      runInClusterScope({ projectId: null, environment: "production" }, () =>
        fetchDisplayUsdPrices(priceEnv, [mint])
      );

    expect(await lookup()).toEqual(new Map());
    clearDisplayPriceCacheForTests();
    const results = await Promise.all(Array.from({ length: 100 }, lookup));
    expect(results.every((result) => result.size === 0)).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not let an old owner overwrite a successor or remove its lease", async () => {
    await store.lookup(["A"], "old");
    // Simulate the lease expiring and another replica claiming the work.
    await first.set(`${prefix}:lease:A`, "new", "PX", 7_000);
    await store.complete(["A"], "old", new Map([["A", price(1)]]));
    expect(await first.get(`${prefix}:lease:A`)).toBe("new");
    expect(await first.exists(`${prefix}:price:A`)).toBe(0);
    const fresh = new Map([["A", price(2)]]);
    await replica.complete(["A"], "new", fresh);
    expect((await store.lookup(["A"], null)).prices).toEqual(fresh);
  });

  it("bounds abandoned leases so a crashed replica cannot block a mint indefinitely", async () => {
    await store.lookup(["A"], "crashed");
    expect(await first.pttl(`${prefix}:lease:A`)).toBeGreaterThan(6_000);
    expect(await first.pttl(`${prefix}:lease:A`)).toBeLessThanOrEqual(7_000);
    await first.del(`${prefix}:lease:A`);
    expect((await replica.lookup(["A"], "recovered")).claimed).toEqual(["A"]);
  });

  it("enforces the burst budget atomically across concurrent replicas", async () => {
    const results = await Promise.all(
      Array.from({ length: 400 }, (_, index) => (index % 2 === 0 ? store : replica).admitRequest())
    );
    expect(results.filter(Boolean)).toHaveLength(320);
    expect(await first.zcard(`${prefix}:requests`)).toBe(320);
  });

  it("enforces the sustained budget even when the burst window has capacity", async () => {
    const now = await serverNow();
    const entries = Array.from({ length: 799 }, (_, index) => [
      now - 11_000,
      `previous-${index}`,
    ]).flat();
    await first.zadd(`${prefix}:requests`, ...entries);
    const results = await Promise.all([store.admitRequest(), replica.admitRequest()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await first.zcard(`${prefix}:requests`)).toBe(800);
  });

  it("drops expired reservations using Redis time", async () => {
    const now = await serverNow();
    const entries = Array.from({ length: 800 }, (_, index) => [
      now - 61_000,
      `expired-${index}`,
    ]).flat();
    await first.zadd(`${prefix}:requests`, ...entries);
    expect(await replica.admitRequest()).toBe(true);
    expect(await first.zcard(`${prefix}:requests`)).toBe(1);
  });

  it("shares 429 cooldown across replicas without discarding successful cache entries", async () => {
    await store.lookup(["A"], "one");
    const answer = new Map([["A", price(2)]]);
    await store.complete(["A"], "one", answer);
    await store.backOff();
    expect(await replica.admitRequest()).toBe(false);
    expect((await replica.lookup(["A"], null)).prices).toEqual(answer);
    const ttl = await first.pttl(`${prefix}:cooldown`);
    expect(ttl).toBeGreaterThan(59_000);
    expect(ttl).toBeLessThanOrEqual(61_000);
  });
});
