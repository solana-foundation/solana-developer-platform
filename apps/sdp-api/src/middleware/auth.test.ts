/**
 * Authentication middleware tests
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
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
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

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
    await clearKVNamespaces(env);
  });

  async function seedDatabaseApiKey(allowedIps: string[] | null): Promise<void> {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)"
        )
        .bind(TEST_USER.id, TEST_USER.email, 1, TEST_USER.status),
      getDb(env)
        .prepare(
          `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          TEST_PROJECT.id,
          TEST_PROJECT.organizationId,
          TEST_PROJECT.name,
          TEST_PROJECT.slug,
          TEST_PROJECT.environment,
          TEST_PROJECT.status,
          TEST_PROJECT.createdBy
        ),
      getDb(env)
        .prepare(
          `INSERT INTO api_keys
             (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, allowed_ips, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          TEST_API_KEY.id,
          TEST_ORG.id,
          TEST_PROJECT.id,
          TEST_USER.id,
          "Allowed IPs test key",
          TEST_API_KEY.prefix,
          validKeyHash,
          TEST_CACHED_API_KEY.role,
          JSON.stringify(TEST_CACHED_API_KEY.permissions),
          allowedIps ? JSON.stringify(allowedIps) : null,
          "active"
        ),
    ]);
  }

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

  describe("allowed IPs", () => {
    it("allows cached API keys from a configured CIDR", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        allowedIps: ["203.0.113.0/24"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "cf-connecting-ip": "203.0.113.42",
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("uses x-forwarded-for when Cloudflare IP is unavailable", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        allowedIps: ["203.0.113.42"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "x-forwarded-for": "203.0.113.42, 198.51.100.10",
          },
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("rejects cached API keys outside the configured CIDR", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        allowedIps: ["203.0.113.0/24"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "cf-connecting-ip": "198.51.100.42",
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_API_KEY");
    });

    it("rejects malformed cached allowlists closed", async () => {
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        allowedIps: ["not-a-cidr"],
      });

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "cf-connecting-ip": "203.0.113.42",
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_API_KEY");
    });

    it("enforces allowed IPs for database-loaded API keys", async () => {
      await seedDatabaseApiKey(["203.0.113.0/24"]);

      const res = await app.request(
        `/v1/organizations/${TEST_CACHED_API_KEY.organizationId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "cf-connecting-ip": "198.51.100.42",
          },
        },
        env
      );

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_API_KEY");
    });
  });

  describe("key status validation", () => {
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
