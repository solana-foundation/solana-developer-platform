import { hashString } from "@sdp/payments/hash";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { AppError } from "@/lib/errors";
import { optionalAuth } from "@/middleware/auth";
import { kvStoreMiddleware } from "@/middleware/kv-store";
import { KEYED_IP_BACKSTOP_MAX_REQUESTS } from "@/middleware/rate-limit";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import {
  clearKVStores,
  readRateLimitCount,
  seedCachedApiKey,
  seedRateLimit,
} from "@/test/mocks/kv";
import type { Env } from "@/types/env";

/**
 * From TEST-NET-3 (203.0.113.0/24, RFC 5737) — reserved for documentation and
 * tests, never publicly routable. Must be a syntactically valid IP because
 * getClientIp drops x-forwarded-for entries that fail isIP(), which would
 * silently move these tests to the "unknown" bucket.
 */
const CLIENT_IP = "203.0.113.7";

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

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  describe("per-key tier limits", () => {
    it("allows a standard-tier key under its limit and reports tier headers", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    });

    it("returns 429 when a standard-tier key exceeds its limit", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);
      await seedRateLimit(env, TEST_CACHED_API_KEY.id, 100);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).not.toBeNull();
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("RATE_LIMITED");
    });

    it("honors the elevated tier from the cached key", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        rateLimitTier: "elevated",
      });
      await seedRateLimit(env, TEST_CACHED_API_KEY.id, 100);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("500");
    });

    it("honors the unlimited tier from the cached key", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        rateLimitTier: "unlimited",
      });
      await seedRateLimit(env, TEST_CACHED_API_KEY.id, 600);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Limit")).toBe("10000");
    });

    it("counts the previous window proportionally (sliding window)", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);
      await seedRateLimit(env, TEST_CACHED_API_KEY.id, 1_000_000, 1);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
    });

    it("does not consume quota on rejected requests", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);
      await seedRateLimit(env, TEST_CACHED_API_KEY.id, 100);

      const res = await keyedRequest();

      expect(res.status).toBe(429);
      expect(await readRateLimitCount(env, TEST_CACHED_API_KEY.id)).toBe(100);
    });

    it("reports remaining quota against the tier limit", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
      expect(res.headers.get("X-RateLimit-Remaining")).toBe("99");
      expect(Number(res.headers.get("X-RateLimit-Reset"))).toBeGreaterThan(Date.now() / 1000 - 1);
    });
  });

  describe("anonymous IP limit", () => {
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
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);
      await seedRateLimit(env, CLIENT_IP, 20);

      const res = await keyedRequest();

      expect(res.status).not.toBe(429);
    });

    it("still caps keyed requests at the per-IP backstop", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);
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
    function optionalAuthApp(): Hono<{ Bindings: Env }> {
      const mini = new Hono<{ Bindings: Env }>();
      mini.onError((err, c) => {
        if (err instanceof AppError && err.code === "RATE_LIMITED") {
          return c.json(err.toResponse(), 429);
        }
        throw err;
      });
      mini.use("*", kvStoreMiddleware());
      mini.use("*", optionalAuth());
      mini.get("/resource", (c) => c.text("ok"));
      return mini;
    }

    it("swallows auth failures for unknown keys", async () => {
      const res = await optionalAuthApp().request(
        "/resource",
        { headers: { Authorization: "Bearer sk_test_unknown_key" } },
        env
      );

      expect(res.status).toBe(200);
    });

    it("rethrows RATE_LIMITED instead of degrading to anonymous", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);
      await seedRateLimit(env, TEST_CACHED_API_KEY.id, 100);

      const res = await optionalAuthApp().request(
        "/resource",
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );

      expect(res.status).toBe(429);
    });
  });
});
