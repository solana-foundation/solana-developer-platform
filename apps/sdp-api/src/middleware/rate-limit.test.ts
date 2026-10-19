import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { currentDatabaseIdentity } from "@/db/identity";
import { app } from "@/index";
import { AppError, rateLimited } from "@/lib/errors";
import * as organizationAccess from "@/lib/organization-access";
import { apiKeyFloodGuardFallback, authMiddleware, optionalAuth } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import {
  ANONYMOUS_EARN_BUILD_MAX_REQUESTS,
  ANONYMOUS_EARN_CATALOGUE_MAX_REQUESTS,
  API_KEY_PRE_READ_MAX_REQUESTS,
  apiKeyFloodGuardIdentifier,
  enforceRateLimit,
  InProcessRateLimiter,
  KEYED_IP_BACKSTOP_MAX_REQUESTS,
  keyedIpBackstopFallback,
  nextAdmissionAt,
  RATE_LIMIT_WINDOW_MS,
  skipRateLimitPaths,
} from "@/middleware/rate-limit";
import type { KVStore, KVStoreSet } from "@/runtime/kv";
import { TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, readRateLimitCount, seedRateLimit } from "@/test/mocks/kv";
import type { Env } from "@/types/env";

/**
 * From TEST-NET-3 (203.0.113.0/24, RFC 5737) — reserved for documentation and
 * tests, never publicly routable. Must be a syntactically valid IP because
 * getClientIp drops x-forwarded-for entries that fail isIP(), which would
 * silently move these tests to the "unknown" bucket.
 */
const CLIENT_IP = "203.0.113.7";

/** A counter store whose every call fails, as during a Redis outage. */
function unavailableKvStoreSet(): KVStoreSet {
  const down = () => Promise.reject(new Error("kv down"));
  const store: KVStore = {
    get: down,
    put: down,
    delete: down,
    compareAndSet: down,
    compareAndDelete: down,
    list: down,
    admitSlidingWindow: down,
  };
  return { rateLimits: store, cache: store };
}

async function keyedRequest(): Promise<Response> {
  return await app.request(
    `/v1/organizations/${TEST_ORG.id}`,
    {
      headers: {
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
        "x-forwarded-for": CLIENT_IP,
      },
    },
    env
  );
}

describe("Rate limiting", () => {
  let validKeyHash: string;

  beforeEach(async () => {
    await seedTestDatabase(env);

    await getDb(env)
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
      .run();

    validKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  });

  /** The flood guard counts per key hash, before the key's row is read. */
  const floodCounter = (clientIp: string = CLIENT_IP) =>
    apiKeyFloodGuardIdentifier(validKeyHash, clientIp);
  /** The key's own tier counts per key id. */
  const tierCounter = TEST_SEEDED_API_KEY.id;

  afterEach(async () => {
    vi.restoreAllMocks();
    await clearKVStores(env);
  });

  describe("per-key tier limits", () => {
    it("allows a standard-tier key under its limit and reports tier headers", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    });

    it("returns 429 when a standard-tier key exceeds its limit", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, tierCounter, 100);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).not.toBeNull();
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("honors the elevated tier from the key row", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        rateLimitTier: "elevated",
      });
      await seedRateLimit(env, tierCounter, 100);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("500");
    });

    it("honors the unlimited tier from the key row", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        rateLimitTier: "unlimited",
      });
      await seedRateLimit(env, tierCounter, 600);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("10000");
    });

    it("counts the previous window proportionally (sliding window)", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, tierCounter, 1_000_000, 1);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
    });

    it("does not consume quota on rejected requests", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, tierCounter, 100);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
      expect(await readRateLimitCount(env, tierCounter)).toBe(100);
    });

    it("still admits a key's tier worth while its client stays above the tier", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, tierCounter, 99);

      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await keyedRequest()).status);

      expect(statuses).toEqual([200, 429, 429]);
      expect(await readRateLimitCount(env, tierCounter)).toBe(100);
      // The first refusal is remembered, so the third attempt is refused from
      // memory before the flood guard counts it.
      expect(await readRateLimitCount(env, floodCounter())).toBe(2);
    });

    it("refuses a key its tier refused from memory, with no row read", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, tierCounter, 100);
      expect((await keyedRequest()).status).toBe(429);
      const read = vi.spyOn(organizationAccess, "authorizeApiKey");

      const res = await keyedRequest();

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).not.toBeNull();
      expect(read).not.toHaveBeenCalled();
      expect(await readRateLimitCount(env, floodCounter())).toBe(1);
      read.mockRestore();
    });

    it("refuses a flooding key at the highest tier before reading its row", async () => {
      // No row: a read would answer INVALID_API_KEY, so a 429 proves none ran.
      await seedRateLimit(env, floodCounter(), API_KEY_PRE_READ_MAX_REQUESTS);
      const readSpy = vi.spyOn(organizationAccess, "authorizeApiKey");

      const res = await keyedRequest();

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).not.toBeNull();
      expect(readSpy).not.toHaveBeenCalled();
      expect(await readRateLimitCount(env, floodCounter())).toBe(API_KEY_PRE_READ_MAX_REQUESTS);
    });

    // A leaked key flooded from outside its allowlist exhausts only the
    // attacker's own bucket.
    it("does not let a flood from another address throttle the key's owner", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, floodCounter("198.51.100.66"), API_KEY_PRE_READ_MAX_REQUESTS);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
    });

    it("caps the unlimited tier at the same ceiling", async () => {
      await seedApiKeyRow(env, validKeyHash, {
        ...TEST_SEEDED_API_KEY,
        rateLimitTier: "unlimited",
      });
      await seedRateLimit(env, floodCounter(), API_KEY_PRE_READ_MAX_REQUESTS);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
    });

    it("bounds an unknown key's first read like a valid key's", async () => {
      await seedRateLimit(env, floodCounter(), API_KEY_PRE_READ_MAX_REQUESTS);

      expect((await keyedRequest()).status).toBe(429);
    });

    // Once refused for good, a hash is refused from memory: no counter call.
    it("refuses a known-unknown key before the flood guard counts it", async () => {
      expect((await keyedRequest()).status).toBe(401);
      expect((await keyedRequest()).status).toBe(401);

      expect(await readRateLimitCount(env, floodCounter())).toBe(1);
    });

    it("reports remaining quota against the tier limit", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
      expect(Number(res.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(Date.now() / 1000 - 1);
    });
  });

  describe("anonymous IP limit", () => {
    it("gives anonymous Earn catalogue traffic its own generous tier", async () => {
      const identifier = `anonymous:earn:catalogue:ip:${CLIENT_IP}`;
      await seedRateLimit(env, identifier, 20);

      const res = await app.request(
        "/v1/earn/strategies",
        { headers: { "x-forwarded-for": CLIENT_IP } },
        env
      );

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe(
        ANONYMOUS_EARN_CATALOGUE_MAX_REQUESTS.toString()
      );
    });

    it("caps anonymous Earn builds in a separate per-IP tier", async () => {
      const identifier = `anonymous:earn:build:ip:${CLIENT_IP}`;
      await seedRateLimit(env, identifier, ANONYMOUS_EARN_BUILD_MAX_REQUESTS);

      const res = await app.request(
        "/v1/earn/external-wallet/deposit-transactions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": CLIENT_IP },
          body: "{}",
        },
        env
      );

      expect(res.status).toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe(
        ANONYMOUS_EARN_BUILD_MAX_REQUESTS.toString()
      );
    });

    it("does not let an anonymous Earn rejection consume a keyed caller's tier", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(
        env,
        `anonymous:earn:build:ip:${CLIENT_IP}`,
        ANONYMOUS_EARN_BUILD_MAX_REQUESTS
      );

      const res = await app.request(
        "/v1/earn/external-wallet/deposit-transactions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
            "x-forwarded-for": CLIENT_IP,
          },
          body: "{}",
        },
        env
      );

      expect(res.status).not.toBe(429);
    });

    it("returns 429 for unauthenticated traffic over the anonymous limit", async () => {
      await seedRateLimit(env, CLIENT_IP, 20);

      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        { headers: { "x-forwarded-for": CLIENT_IP } },
        env
      );

      expect(res.status).toBe(429);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("does not cap keyed requests at the anonymous limit", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, CLIENT_IP, 20);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
    });

    it("still caps keyed requests at the per-IP backstop", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, CLIENT_IP, KEYED_IP_BACKSTOP_MAX_REQUESTS);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
    });

    it("skips rate limiting on exempt paths", async () => {
      await seedRateLimit(env, CLIENT_IP, 20);

      const res = await app.request("/health", { headers: { "x-forwarded-for": CLIENT_IP } }, env);

      expect(res.status).toBe(200);
    });
  });

  describe("optionalAuth", () => {
    function optionalAuthApp(options: { rejectInvalid?: boolean } = {}): Hono<{ Bindings: Env }> {
      const mini = new Hono<{ Bindings: Env }>();
      mini.onError((err, c) => {
        if (err instanceof AppError) {
          // SAFETY: AppError status codes are the API's own error statuses.
          return c.json(err.toResponse(), err.statusCode as 429 | 401);
        }
        throw err;
      });
      mini.use("*", kvStoreMiddleware());
      mini.use("*", optionalAuth(options));
      mini.get("/resource", (c) => c.json({ identity: currentDatabaseIdentity() }));
      return mini;
    }

    it("rejects an unknown key by default instead of degrading to anonymous", async () => {
      const res = await optionalAuthApp().request(
        "/resource",
        { headers: { Authorization: "Bearer sk_test_unknown_key" } },
        env
      );

      expect(res.status).toBe(401);
    });

    it("can be configured to swallow an invalid key as anonymous", async () => {
      const res = await optionalAuthApp({ rejectInvalid: false }).request(
        "/resource",
        { headers: { Authorization: "Bearer sk_test_unknown_key" } },
        env
      );

      expect(res.status).toBe(200);
    });

    it("admits a truly anonymous request without a key", async () => {
      const res = await optionalAuthApp().request("/resource", {}, env);

      expect(res.status).toBe(200);
    });

    it("can reject an invalid key without requiring a key", async () => {
      const mini = new Hono<{ Bindings: Env }>();
      mini.onError((err, c) => {
        if (err instanceof AppError) {
          return c.json(err.toResponse(), 401);
        }
        throw err;
      });
      mini.use("*", kvStoreMiddleware());
      mini.use("*", optionalAuth({ rejectInvalid: true }));
      mini.get("/resource", (c) => c.json({ ok: true }));

      const anonymous = await mini.request("/resource", {}, env);
      const invalid = await mini.request(
        "/resource",
        { headers: { Authorization: "Bearer sk_test_unknown_key" } },
        env
      );

      expect(anonymous.status).toBe(200);
      expect(invalid.status).toBe(401);
    });

    it("rethrows RATE_LIMITED instead of degrading to anonymous", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      await seedRateLimit(env, tierCounter, 100);

      const res = await optionalAuthApp().request(
        "/resource",
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(429);
    });

    it("runs a keyless route under the presented key's tenant identity", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);

      const res = await optionalAuthApp().request(
        "/resource",
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        identity: {
          kind: "tenant",
          organizationId: TEST_SEEDED_API_KEY.organizationId,
        },
      });
    });
  });

  describe("storage failure semantics", () => {
    function enforcementApp(options: {
      kv: "broken" | "missing";
      failClosed: boolean;
      fallback?: InProcessRateLimiter;
      maxRequests?: number;
    }): Hono<{ Bindings: Env }> {
      const mini = new Hono<{ Bindings: Env }>();
      mini.onError((err, c) => {
        if (err instanceof AppError) {
          // SAFETY: AppError status codes are the API's own error statuses.
          return c.json(err.toResponse(), err.statusCode as 429 | 503);
        }
        throw err;
      });
      if (options.kv === "broken") {
        mini.use("*", async (c, next) => {
          c.set("kv", unavailableKvStoreSet());
          await next();
        });
      }
      mini.get("/resource", async (c) => {
        await enforceRateLimit(c, "storage-failure-test", options.maxRequests ?? 5, {
          failClosed: options.failClosed,
          fallback: options.fallback,
        });
        return c.text("ok");
      });
      return mini;
    }

    it("fails open on storage errors by default", async () => {
      const res = await enforcementApp({ kv: "broken", failClosed: false }).request(
        "/resource",
        {},
        env
      );

      expect(res.status).toBe(200);
    });

    it("fails closed with a 503 on storage errors when requested", async () => {
      const res = await enforcementApp({ kv: "broken", failClosed: true }).request(
        "/resource",
        {},
        env
      );

      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("SERVICE_UNAVAILABLE");
    });

    it("fails closed with a 503 when no counter store is bound", async () => {
      const res = await enforcementApp({ kv: "missing", failClosed: true }).request(
        "/resource",
        {},
        env
      );

      expect(res.status).toBe(503);
    });

    it("counts in this instance's memory while the store is broken", async () => {
      const app = enforcementApp({
        kv: "broken",
        failClosed: false,
        fallback: new InProcessRateLimiter("test", 10),
        maxRequests: 2,
      });

      const statuses: number[] = [];
      for (let i = 0; i < 3; i++) statuses.push((await app.request("/resource", {}, env)).status);

      expect(statuses).toEqual([200, 200, 429]);
    });

    it("bounds the in-process fallback's memory, forgetting the coldest counts", async () => {
      const limiter = new InProcessRateLimiter("test", 2);
      const app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) =>
        err instanceof AppError ? c.json(err.toResponse(), 429) : c.text("error", 500)
      );
      app.get("/:identifier", (c) => {
        limiter.enforce(c, c.req.param("identifier"), 1, RATE_LIMIT_WINDOW_MS);
        return c.text("ok");
      });
      const status = async (identifier: string) =>
        (await app.request(`/${identifier}`, {}, env)).status;

      expect(await status("a")).toBe(200);
      expect(await status("a")).toBe(429);
      expect(await status("b")).toBe(200);
      expect(await status("c")).toBe(200);
      // "a" was the coldest of three in a map of two, so it starts again.
      expect(await status("a")).toBe(200);
    });

    it("guards the API-key auth read in memory while Redis is down", async () => {
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
      const fallback = vi.spyOn(apiKeyFloodGuardFallback, "enforce");
      const read = vi.spyOn(organizationAccess, "authorizeApiKey");
      const app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) =>
        err instanceof AppError
          ? // SAFETY: AppError status codes are the API's own error statuses.
            c.json(err.toResponse(), err.statusCode as 401 | 429)
          : c.text("error", 500)
      );
      app.use("*", async (c, next) => {
        c.set("kv", unavailableKvStoreSet());
        await next();
      });
      app.use("*", authMiddleware());
      app.get("/resource", (c) => c.text("ok"));
      const request = () =>
        app.request(
          "/resource",
          {
            headers: { Authorization: `Bearer ${TEST_API_KEY.raw}`, "x-forwarded-for": CLIENT_IP },
          },
          env
        );

      expect((await request()).status).toBe(200);
      expect(fallback).toHaveBeenCalledWith(
        expect.anything(),
        floodCounter(),
        API_KEY_PRE_READ_MAX_REQUESTS,
        RATE_LIMIT_WINDOW_MS
      );

      fallback.mockImplementationOnce(() => {
        throw rateLimited("Rate limit exceeded.");
      });
      read.mockClear();
      expect((await request()).status).toBe(429);
      expect(read).not.toHaveBeenCalled();
    });

    it("bounds fresh-key spray per IP in memory while Redis is down", async () => {
      const backstop = vi.spyOn(keyedIpBackstopFallback, "enforce");
      const read = vi.spyOn(organizationAccess, "authorizeApiKey");
      const app = new Hono<{ Bindings: Env }>();
      app.onError((err, c) =>
        err instanceof AppError
          ? // SAFETY: AppError status codes are the API's own error statuses.
            c.json(err.toResponse(), err.statusCode as 401 | 429)
          : c.text("error", 500)
      );
      app.use("*", async (c, next) => {
        c.set("kv", unavailableKvStoreSet());
        await next();
      });
      app.use("*", skipRateLimitPaths());
      app.use("*", authMiddleware());
      app.get("/resource", (c) => c.text("ok"));
      const request = (key: string) =>
        app.request(
          "/resource",
          { headers: { Authorization: `Bearer ${key}`, "x-forwarded-for": CLIENT_IP } },
          env
        );

      // A fresh key per request misses every per-hash counter; the IP one counts.
      expect((await request("sk_test_spray_one")).status).toBe(401);
      expect((await request("sk_test_spray_two")).status).toBe(401);
      expect(backstop).toHaveBeenCalledTimes(2);
      expect(backstop).toHaveBeenLastCalledWith(
        expect.anything(),
        CLIENT_IP,
        KEYED_IP_BACKSTOP_MAX_REQUESTS,
        RATE_LIMIT_WINDOW_MS
      );

      backstop.mockImplementationOnce(() => {
        throw rateLimited("Rate limit exceeded.");
      });
      read.mockClear();
      expect((await request("sk_test_spray_three")).status).toBe(429);
      expect(read).not.toHaveBeenCalled();
    });
  });
});

describe("nextAdmissionAt", () => {
  const window = { windowStart: 60_000, windowMs: 60_000, cost: 1, maxRequests: 100 };

  it("waits for the window to end when the current window alone is full", () => {
    expect(nextAdmissionAt({ ...window, admission: { current: 100, previous: 0 } })).toBe(120_000);
  });

  it("admits once the previous window's weighted share leaves room", () => {
    // Room for one: admitted once 100 * weight < 1, i.e. after 99% of the window.
    expect(nextAdmissionAt({ ...window, admission: { current: 99, previous: 100 } })).toBe(
      60_000 + 59_401
    );
  });

  it("admits halfway through when half the previous window must decay", () => {
    expect(nextAdmissionAt({ ...window, admission: { current: 0, previous: 200 } })).toBe(
      60_000 + 30_001
    );
  });

  it("never answers past the window's end", () => {
    expect(nextAdmissionAt({ ...window, cost: 50, admission: { current: 60, previous: 10 } })).toBe(
      120_000
    );
  });
});
