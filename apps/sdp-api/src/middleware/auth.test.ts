/**
 * Authentication middleware tests
 */

import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { isRotationDeadlineReached } from "@/lib/api-key-rotation";
import { createKVStoreSet } from "@/runtime/kv-redis";
import {
  TEST_API_KEY,
  TEST_CACHED_API_KEY,
  TEST_EXPIRED_KEY,
  TEST_REVOKED_KEY,
} from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

describe("Auth Middleware", () => {
  let validKeyHash: string;

  beforeEach(async () => {
    // Set up database schema
    await seedTestDatabase(env);

    // Seed organization for tests that need it
    await getDb(env)
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
      .run();

    // Hash the test key with the configured pepper
    validKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  describe("key extraction", () => {
    it("accepts Bearer token format", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      // Should not be 401 (auth succeeded, might be 404 if org doesn't exist)
      expect(res.status).not.toBe(401);
    });

    it("accepts raw key format", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: TEST_API_KEY.raw,
          },
        },
        env
      );

      expect(res.status).not.toBe(401);
    });

    it("rejects requests without Authorization header", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {},
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("UNAUTHORIZED");
    });

    it("rejects invalid Authorization header format", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: "Basic invalid",
          },
        },
        env
      );

      expect(res.status).toBe(401);
    });
  });

  describe("key validation", () => {
    it("rejects invalid key format (not sk_test or sk_live)", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: "Bearer invalid_key_format",
          },
        },
        env
      );

      // INVALID_API_KEY returns 401
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_API_KEY");
    });

    it("rejects unknown API keys", async () => {
      // Don't seed anything - key won't be found
      const unknownKey = "sk_test_unknown_fixture";

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${unknownKey}`,
          },
        },
        env
      );

      // INVALID_API_KEY returns 401
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_API_KEY");
    });

    it("accepts valid API keys from KV cache", async () => {
      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      // Auth succeeded and org exists
      expect(res.status).toBe(200);
    });
  });

  describe("key status validation", () => {
    it("treats the exact rotation deadline as expired for a zero-hour grace period", () => {
      const deadline = "2026-07-23T12:00:00.000Z";
      const deadlineMs = Date.parse(deadline);

      expect(isRotationDeadlineReached(deadline, deadlineMs - 1)).toBe(false);
      expect(isRotationDeadlineReached(deadline, deadlineMs)).toBe(true);
    });

    it("fails closed when a persisted rotation deadline is malformed", () => {
      expect(isRotationDeadlineReached("not-a-timestamp", Date.now())).toBe(true);
    });

    it("rejects revoked API keys", async () => {
      const revokedKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
      await seedCachedApiKey(env, revokedKeyHash, TEST_REVOKED_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("REVOKED_API_KEY");
    });

    it("rejects expired API keys", async () => {
      const expiredKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
      await seedCachedApiKey(env, expiredKeyHash, TEST_EXPIRED_KEY);

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("EXPIRED_API_KEY");
    });

    it("rejects rotated API keys after their cached grace period ends", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        rotationDeadline: "2020-01-01T00:00:00.000Z",
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("EXPIRED_API_KEY");
    });

    it("accepts rotated API keys while their cached grace period is active", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        rotationDeadline: "2999-01-01T00:00:00.000Z",
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("bypasses a legacy cache entry and rejects a database key past its rotation deadline", async () => {
      await getDb(env)
        .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
        .bind(TEST_USER.id, TEST_USER.email)
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO projects
             (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, 'active', ?)`
        )
        .bind(
          TEST_PROJECT.id,
          TEST_ORG.id,
          TEST_PROJECT.name,
          TEST_PROJECT.slug,
          TEST_PROJECT.environment,
          TEST_USER.id
        )
        .run();
      await getDb(env)
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
              role, permissions, status, rotation_deadline)
           VALUES (?, ?, ?, ?, 'Rotated key', ?, ?, 'api_admin', '["*"]', 'active', ?)`
        )
        .bind(
          TEST_API_KEY.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_USER.id,
          TEST_API_KEY.prefix,
          validKeyHash,
          "2020-01-01T00:00:00.000Z"
        )
        .run();

      // Simulate the pre-enforcement payload shape still present in Redis at deploy time.
      const { rotationDeadline: _, ...legacyCachedKey } = TEST_CACHED_API_KEY;
      await createKVStoreSet(env).apiKeys.put(
        `key:${validKeyHash}`,
        JSON.stringify(legacyCachedKey)
      );

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("EXPIRED_API_KEY");
    });
  });

  describe("permissions", () => {
    it("allows access with wildcard permission", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["*"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      // Auth + permissions passed, org exists
      expect(res.status).toBe(200);
    });

    it("allows access with specific permission", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["org:read", "org:write"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      // Should pass permission check, org exists
      expect(res.status).toBe(200);
    });

    it("rejects requests without required permissions", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["tokens:read"], // No org:read permission
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("INSUFFICIENT_PERMISSIONS");
    });
  });
});
