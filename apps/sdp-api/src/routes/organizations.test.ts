/**
 * Organizations route tests
 */

import type { Organization } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_MEMBER, TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

describe("Organizations routes", () => {
  let validKeyHash: string;

  beforeEach(async () => {
    // Set up database schema
    await seedTestDatabase(env);

    // Hash the test key with the configured pepper
    validKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  describe("POST /v1/organizations", () => {
    it("does not expose local organization self-registration", async () => {
      const res = await app.request(
        "/v1/organizations",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "New Org",
            email: "new@example.com",
          }),
        },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/organizations/:orgId", () => {
    beforeEach(async () => {
      // Seed organization and auth
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
        .run();

      await seedCachedApiKey(env, validKeyHash, TEST_CACHED_API_KEY);
    });

    it("returns organization details", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: Organization };
      expect(body.data.id).toBe(TEST_ORG.id);
      expect(body.data.name).toBe(TEST_ORG.name);
      expect(body.data.slug).toBe(TEST_ORG.slug);
    });

    it("returns internal error when organization tier is invalid in storage", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET tier = ? WHERE id = ?")
        .bind("totally-invalid-tier", TEST_ORG.id)
        .run();

      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("returns internal error when organization status is invalid in storage", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET status = ? WHERE id = ?")
        .bind("unknown", TEST_ORG.id)
        .run();

      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("INTERNAL_ERROR");
    });

    it("rejects unauthenticated requests", async () => {
      const res = await app.request(`/v1/organizations/${TEST_ORG.id}`, {}, env);

      expect(res.status).toBe(401);
    });

    it("rejects access to other organizations", async () => {
      const res = await app.request(
        "/v1/organizations/org_different12345",
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FORBIDDEN");
    });

    it("returns 404 for non-existent organization", async () => {
      // Create key for a non-existent org
      const nonExistentOrgId = "org_nonexistent123";
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        organizationId: nonExistentOrgId,
      });

      const res = await app.request(
        `/v1/organizations/${nonExistentOrgId}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /v1/organizations/:orgId", () => {
    beforeEach(async () => {
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
        .run();

      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["*"],
      });
    });

    it("updates organization name", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "Updated Name",
          }),
        },
        env
      );

      expect(res.status).toBe(200);

      const body = (await res.json()) as { data: { name: string } };
      expect(body.data.name).toBe("Updated Name");
    });

    it("updates organization settings", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            settings: {
              defaultEnvironment: "production",
            },
          }),
        },
        env
      );

      expect(res.status).toBe(200);
    });

    it("allows Helius for individual-tier organizations when configured", async () => {
      const originalHeliusUrl = env.SOLANA_RPC_HELIUS_URL;
      env.SOLANA_RPC_HELIUS_URL = "https://rpc.helius.test";

      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            settings: {
              rpcProvider: "helius",
            },
          }),
        },
        env
      );

      env.SOLANA_RPC_HELIUS_URL = originalHeliusUrl;

      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Organization };
      expect(body.data.settings?.rpcProvider).toBe("helius");
    });

    it("rejects empty update", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
        env
      );

      expect(res.status).toBe(400);
    });

    it("requires org:write permission", async () => {
      // Re-seed with limited permissions
      await clearKVNamespaces(env);
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["org:read"], // No write permission
      });

      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "New Name" }),
        },
        env
      );

      expect(res.status).toBe(403);
    });
  });

  describe("DELETE /v1/organizations/:orgId", () => {
    beforeEach(async () => {
      // Create org with user and API key
      await getDb(env).batch([
        getDb(env)
          .prepare(
            "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status),

        getDb(env)
          .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
          .bind(TEST_USER.id, TEST_USER.email, 0, TEST_USER.status),

        getDb(env)
          .prepare(
            "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, ?, ?)"
          )
          .bind(TEST_MEMBER.id, TEST_MEMBER.organizationId, TEST_MEMBER.userId, "admin", "active"),

        getDb(env)
          .prepare(
            "INSERT INTO api_keys (id, organization_id, created_by, name, key_prefix, key_hash, role, environment, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            TEST_API_KEY.id,
            TEST_ORG.id,
            TEST_USER.id,
            "Test Key",
            TEST_API_KEY.prefix,
            validKeyHash,
            "api_admin",
            "sandbox",
            "active"
          ),
      ]);

      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["*"],
      });
    });

    it("soft deletes organization", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(204);

      // Verify org is soft deleted
      const org = await getDb(env)
        .prepare("SELECT status FROM organizations WHERE id = ?")
        .bind(TEST_ORG.id)
        .first<{ status: string }>();

      expect(org?.status).toBe("deleted");
    });

    it("revokes all API keys on delete", async () => {
      await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      const keys = await getDb(env)
        .prepare("SELECT status FROM api_keys WHERE organization_id = ?")
        .bind(TEST_ORG.id)
        .all<{ status: string }>();

      for (const key of keys.results) {
        expect(key.status).toBe("revoked");
      }
    });

    it("marks organization members removed on delete", async () => {
      await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      const members = await getDb(env)
        .prepare("SELECT status FROM organization_members WHERE organization_id = ?")
        .bind(TEST_ORG.id)
        .all<{ status: string }>();

      for (const member of members.results) {
        expect(member.status).toBe("removed");
      }
    });

    it("requires org:admin permission", async () => {
      await clearKVNamespaces(env);
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["org:read", "org:write"], // No admin permission
      });

      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );

      expect(res.status).toBe(403);
    });
  });
});
