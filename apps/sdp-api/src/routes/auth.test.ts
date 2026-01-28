/**
 * Auth Routes E2E Tests
 */

import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/d1";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Auth Routes", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    // Clear magic_links and sessions tables before each test
    const db = (env as { DB: D1Database }).DB;
    await db
      .prepare("DELETE FROM magic_links")
      .run()
      .catch(() => {});
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

  describe("POST /v1/auth/magic-link", () => {
    it("returns success for any email (doesn't reveal if user exists)", async () => {
      const res = await app.request(
        "/v1/auth/magic-link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "nonexistent@example.com" }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.success).toBe(true);
      expect(body.data.message).toContain("If an account exists");
    });

    it("creates magic link for existing user", async () => {
      // Seed org, user, and membership
      const db = (env as { DB: D1Database }).DB;

      await db
        .prepare(
          "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'free', 'active')"
        )
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
        .run();

      await db
        .prepare(
          "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
        )
        .bind(TEST_USER.id, TEST_USER.email)
        .run();

      await db
        .prepare(
          "INSERT OR REPLACE INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'owner', 'active')"
        )
        .bind("mem_test123", TEST_ORG.id, TEST_USER.id)
        .run();

      const res = await app.request(
        "/v1/auth/magic-link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: TEST_USER.email }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.success).toBe(true);

      // Verify magic link was created in DB
      const link = await db
        .prepare("SELECT * FROM magic_links WHERE email = ?")
        .bind(TEST_USER.email.toLowerCase())
        .first();
      expect(link).not.toBeNull();
    });

    it("returns 400 for invalid email", async () => {
      const res = await app.request(
        "/v1/auth/magic-link",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "not-an-email" }),
        },
        env
      );

      expect(res.status).toBe(400);
    });
  });

  describe("GET /v1/auth/magic-link/verify", () => {
    it("returns 400 without token", async () => {
      const res = await app.request("/v1/auth/magic-link/verify", {}, env);

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("Token is required");
    });

    it("returns 401 for invalid token", async () => {
      // biome-ignore lint/nursery/noSecrets: Test token in URL, not a real secret
      const res = await app.request("/v1/auth/magic-link/verify?token=invalidtoken123", {}, env);

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("INVALID_TOKEN");
    });

    it("creates session for valid token", async () => {
      const db = (env as { DB: D1Database }).DB;

      // Seed user
      await db
        .prepare(
          "INSERT OR IGNORE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
        )
        .bind(TEST_USER.id, TEST_USER.email)
        .run();

      // Seed org
      await db
        .prepare(
          "INSERT OR IGNORE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'free', 'active')"
        )
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
        .run();

      // Seed membership
      await db
        .prepare(
          "INSERT OR IGNORE INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, 'owner', 'active')"
        )
        .bind("mem_test456", TEST_ORG.id, TEST_USER.id)
        .run();

      // Create magic link directly
      // biome-ignore lint/nursery/noSecrets: Test token fixture, not a real secret
      const token = "validtoken123456789012345678901234567890123456";
      const tokenHash = await hashString(token);
      const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

      await db
        .prepare("INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)")
        .bind("ml_test123", TEST_USER.email.toLowerCase(), tokenHash, expiresAt)
        .run();

      const res = await app.request(`/v1/auth/magic-link/verify?token=${token}`, {}, env);

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.session).toBeDefined();
      expect(body.data.session.id).toMatch(/^ses_/);
      expect(body.data.user.email).toBe(TEST_USER.email);

      // Verify session was created
      const session = await db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .bind(body.data.session.id)
        .first();
      expect(session).not.toBeNull();

      // Verify cookie was set
      const setCookieHeader = res.headers.get("Set-Cookie");
      expect(setCookieHeader).toContain("sdp_session=");
    });

    it("returns 401 for expired token", async () => {
      const db = (env as { DB: D1Database }).DB;

      // Seed user
      await db
        .prepare(
          "INSERT OR IGNORE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
        )
        .bind(TEST_USER.id, TEST_USER.email)
        .run();

      // Create expired magic link
      // biome-ignore lint/nursery/noSecrets: Test token fixture, not a real secret
      const token = "expiredtoken12345678901234567890123456789012";
      const tokenHash = await hashString(token);
      const expiresAt = new Date(Date.now() - 1000).toISOString(); // Expired

      await db
        .prepare("INSERT INTO magic_links (id, email, token_hash, expires_at) VALUES (?, ?, ?, ?)")
        .bind("ml_expired", TEST_USER.email.toLowerCase(), tokenHash, expiresAt)
        .run();

      const res = await app.request(`/v1/auth/magic-link/verify?token=${token}`, {}, env);

      expect(res.status).toBe(401);
    });
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
