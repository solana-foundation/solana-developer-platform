/**
 * Integration tests for RedisKVStore against a real Redis. Runs in plain
 * Node via vitest.node.config.ts so ioredis can open real TCP sockets.
 * Requires REDIS_URL (defaults to localhost:6379); each test FLUSHALLs
 * first so runs are isolated.
 */

import Redis from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { closeAllRedisClients, createRedisKVStoreSet, RedisKVStore } from "./kv-redis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";

describe("RedisKVStore (HOO-510)", () => {
  let raw: Redis;

  beforeAll(() => {
    raw = new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 3 });
  });

  afterAll(async () => {
    await raw.quit();
  });

  beforeEach(async () => {
    await raw.flushall();
  });

  describe("get / put / delete", () => {
    it("round-trips a string value", async () => {
      const store = new RedisKVStore(raw, "test");
      await store.put("k", "hello");
      expect(await store.get("k")).toBe("hello");
    });

    it("returns null for missing keys", async () => {
      const store = new RedisKVStore(raw, "test");
      expect(await store.get("nope")).toBeNull();
    });

    it("delete() removes the value", async () => {
      const store = new RedisKVStore(raw, "test");
      await store.put("k", "v");
      await store.delete("k");
      expect(await store.get("k")).toBeNull();
    });

    it('get(key, "json") parses JSON', async () => {
      const store = new RedisKVStore(raw, "test");
      await store.put("k", JSON.stringify({ a: 1, nested: { b: "x" } }));
      const value = await store.get<{ a: number; nested: { b: string } }>("k", "json");
      expect(value).toEqual({ a: 1, nested: { b: "x" } });
    });

    it('get(key, "json") returns null when missing', async () => {
      const store = new RedisKVStore(raw, "test");
      expect(await store.get<{ a: number }>("nope", "json")).toBeNull();
    });
  });

  describe("TTL (SET PX)", () => {
    it("sets the millisecond TTL on the underlying key", async () => {
      const store = new RedisKVStore(raw, "test");
      await store.put("k", "v", { expirationTtl: 30 });
      // expirationTtl=30s → PTTL should report ~30_000ms, allowing for
      // elapsed time between put and the inspection.
      const pttl = await raw.pttl("test:k");
      expect(pttl).toBeGreaterThan(28_000);
      expect(pttl).toBeLessThanOrEqual(30_000);
    });

    it("no TTL persists indefinitely (PTTL = -1) — parity with CF KV", async () => {
      const store = new RedisKVStore(raw, "test");
      await store.put("k", "v"); // no options
      const pttl = await raw.pttl("test:k");
      expect(pttl).toBe(-1);
    });
  });

  describe("list() via SCAN", () => {
    it("returns all keys for the store's prefix, with prefix stripped", async () => {
      const store = new RedisKVStore(raw, "test");
      await store.put("a", "1");
      await store.put("b", "2");
      await store.put("c", "3");
      const result = await store.list();
      const names = result.keys.map((k) => k.name).sort();
      expect(names).toEqual(["a", "b", "c"]);
    });

    it("does not leak keys from other prefixes", async () => {
      const apiKeys = new RedisKVStore(raw, "apiKeys");
      const cache = new RedisKVStore(raw, "cache");
      await apiKeys.put("k1", "v1");
      await cache.put("k2", "v2");
      const apiKeysList = await apiKeys.list();
      const cacheList = await cache.list();
      expect(apiKeysList.keys.map((k) => k.name)).toEqual(["k1"]);
      expect(cacheList.keys.map((k) => k.name)).toEqual(["k2"]);
    });

    it("returns an empty result when the store is empty", async () => {
      const store = new RedisKVStore(raw, "empty");
      const result = await store.list();
      expect(result.keys).toEqual([]);
    });
  });

  describe("createRedisKVStoreSet", () => {
    afterEach(async () => {
      // Factory uses a cached client; close between tests so reuse is observable.
      await closeAllRedisClients();
    });

    it("wires four prefixed stores sharing one connection", async () => {
      const set = createRedisKVStoreSet({ REDIS_URL } as Env);
      await set.apiKeys.put("same-key", "from-apiKeys");
      await set.rateLimits.put("same-key", "from-rateLimits");
      await set.cache.put("same-key", "from-cache");
      await set.sessions.put("same-key", "from-sessions");

      expect(await set.apiKeys.get("same-key")).toBe("from-apiKeys");
      expect(await set.rateLimits.get("same-key")).toBe("from-rateLimits");
      expect(await set.cache.get("same-key")).toBe("from-cache");
      expect(await set.sessions.get("same-key")).toBe("from-sessions");
    });

    it("reuses the same Redis client across repeated calls (no connection leak)", () => {
      // Pin reference equality on the cached promise. If the factory ever
      // regresses to per-call construction, the connection-leak comes back.
      const set1 = createRedisKVStoreSet({ REDIS_URL } as Env);
      const set2 = createRedisKVStoreSet({ REDIS_URL } as Env);
      const p1 = (set1.apiKeys as unknown as { clientPromise: Promise<Redis> }).clientPromise;
      const p2 = (set2.apiKeys as unknown as { clientPromise: Promise<Redis> }).clientPromise;
      expect(p1).toBe(p2);
    });

    it("throws a clear error when REDIS_URL is missing", () => {
      expect(() => createRedisKVStoreSet({} as Env)).toThrow(/REDIS_URL missing/);
    });

    it("throws when REDIS_URL is whitespace-only", () => {
      expect(() => createRedisKVStoreSet({ REDIS_URL: "   " } as Env)).toThrow(/REDIS_URL missing/);
    });
  });
});
