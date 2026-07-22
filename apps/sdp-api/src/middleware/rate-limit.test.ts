import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey, seedRateLimit } from "@/test/mocks/kv";

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
  });
});
