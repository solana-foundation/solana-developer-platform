/**
 * Auth Routes E2E Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

describe("Auth Routes", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    // Clear sessions table before each test
    const db = getDb(env);
    await db
      .prepare("DELETE FROM sessions")
      .run()
      .catch(() => {});

    // Clear rate limit KV to prevent 429 errors between tests
    const rateLimitKV = (env as { SDP_RATE_LIMITS: KVNamespace }).SDP_RATE_LIMITS;
    const keys = await rateLimitKV.list();
    for (const key of keys.keys) {
      await rateLimitKV.delete(key.name);
    }
  });

  describe("GET /v1/auth/me (requires session)", () => {
    it("returns 401 without session cookie", async () => {
      const res = await app.request("/v1/auth/me", {}, env);

      expect(res.status).toBe(401);
    });
  });

  describe("POST /v1/auth/logout (requires session)", () => {
    it("returns 401 without session cookie", async () => {
      const res = await app.request("/v1/auth/logout", { method: "POST" }, env);

      expect(res.status).toBe(401);
    });
  });
});
