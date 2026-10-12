import { hashString } from "@sdp/payments/hash";
import type { InvitationStatus, Organization } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_MEMBER, TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { required } from "@/test/helpers/required";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_PROJECT = {
  id: "prj_test_organizations",
  slug: "test-test-org-project",
};

const OTHER_ORG = {
  id: "org_test_organizations_other",
  name: "Other Organization",
  slug: "test-organizations-other",
};

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const DELETION_INVITATIONS: {
  id: string;
  organizationId: string;
  email: string;
  expiresAt: string;
  status: InvitationStatus;
}[] = [
  {
    id: "inv_org_delete_pending",
    organizationId: TEST_ORG.id,
    email: "pending@example.com",
    expiresAt: daysFromNow(7),
    status: "pending",
  },
  {
    id: "inv_org_delete_accepted",
    organizationId: TEST_ORG.id,
    email: "accepted@example.com",
    expiresAt: daysFromNow(7),
    status: "accepted",
  },
  {
    id: "inv_org_delete_expired",
    organizationId: TEST_ORG.id,
    email: "expired@example.com",
    expiresAt: daysFromNow(-7),
    status: "expired",
  },
  {
    id: "inv_org_delete_other_org_pending",
    organizationId: OTHER_ORG.id,
    email: "pending@example.com",
    expiresAt: daysFromNow(7),
    status: "pending",
  },
];

describe("Organizations routes", () => {
  let validKeyHash: string;
  beforeEach(async () => {
    await seedTestDatabase(env);
    validKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  });
  afterEach(async () => {
    await clearKVStores(env);
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
      const body = (await res.json()) as {
        data: Organization;
      };
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
      const body = (await res.json()) as {
        error: {
          code: string;
        };
      };
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
      const body = (await res.json()) as {
        error: {
          code: string;
        };
      };
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
      const body = (await res.json()) as {
        error: {
          code: string;
        };
      };
      expect(body.error.code).toBe("FORBIDDEN");
    });
    it("returns 404 for non-existent organization", async () => {
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
      const body = (await res.json()) as {
        data: {
          name: string;
        };
      };
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
      await clearKVStores(env);
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["org:read"],
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
      ]);
      await seedDefaultProjects(getDb(env), {
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        members: [],
        ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
      });
      await getDb(env).batch([
        getDb(env)
          .prepare(
            "INSERT INTO api_keys (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .bind(
            TEST_API_KEY.id,
            TEST_ORG.id,
            TEST_PROJECT.id,
            TEST_USER.id,
            "Test Key",
            TEST_API_KEY.prefix,
            validKeyHash,
            "api_admin",
            "active"
          ),
      ]);
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["*"],
      });
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(OTHER_ORG.id, OTHER_ORG.name, OTHER_ORG.slug, "individual", "active")
        .run();
      for (const invitation of DELETION_INVITATIONS) {
        await getDb(env)
          .prepare(
            `INSERT INTO invitations (id, organization_id, email, role, invited_by, token_hash, expires_at, status)
             VALUES (?, ?, ?, 'member', ?, ?, ?, ?)`
          )
          .bind(
            invitation.id,
            invitation.organizationId,
            invitation.email,
            TEST_USER.id,
            `hash_${invitation.id}`,
            invitation.expiresAt,
            invitation.status
          )
          .run();
      }
    });
    function deleteOrganization() {
      return app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );
    }
    it("soft deletes organization", async () => {
      const res = await deleteOrganization();
      expect(res.status).toBe(204);
      const org = await getDb(env)
        .prepare("SELECT id, status FROM organizations WHERE id = ?")
        .bind(TEST_ORG.id)
        .first<{
          id: string;
          status: string;
        }>();
      expect(required(org)).toEqual({ id: TEST_ORG.id, status: "deleted" });
    });
    it("revokes all API keys on delete", async () => {
      expect((await deleteOrganization()).status).toBe(204);
      const keys = await getDb(env)
        .prepare("SELECT id, status, revoked_at FROM api_keys WHERE organization_id = ?")
        .bind(TEST_ORG.id)
        .all<{
          id: string;
          status: string;
          revoked_at: string | null;
        }>();
      expect(keys.results).toEqual([
        { id: TEST_API_KEY.id, status: "revoked", revoked_at: expect.any(String) },
      ]);
    });
    it("marks organization members removed on delete", async () => {
      expect((await deleteOrganization()).status).toBe(204);
      const members = await getDb(env)
        .prepare("SELECT id, user_id, status FROM organization_members WHERE organization_id = ?")
        .bind(TEST_ORG.id)
        .all<{
          id: string;
          user_id: string;
          status: string;
        }>();
      expect(members.results).toEqual([
        { id: TEST_MEMBER.id, user_id: TEST_USER.id, status: "removed" },
      ]);
    });
    it("revokes the organization's pending invitations and leaves every other invitation alone", async () => {
      expect((await deleteOrganization()).status).toBe(204);
      const invitations = await getDb(env)
        .prepare(
          "SELECT id, organization_id, email, status FROM invitations WHERE organization_id IN (?, ?) ORDER BY id"
        )
        .bind(TEST_ORG.id, OTHER_ORG.id)
        .all<{
          id: string;
          organization_id: string;
          email: string;
          status: InvitationStatus;
        }>();
      expect(invitations.results).toEqual([
        {
          id: "inv_org_delete_accepted",
          organization_id: TEST_ORG.id,
          email: "accepted@example.com",
          status: "accepted",
        },
        {
          id: "inv_org_delete_expired",
          organization_id: TEST_ORG.id,
          email: "expired@example.com",
          status: "expired",
        },
        {
          id: "inv_org_delete_other_org_pending",
          organization_id: OTHER_ORG.id,
          email: "pending@example.com",
          status: "pending",
        },
        {
          id: "inv_org_delete_pending",
          organization_id: TEST_ORG.id,
          email: "pending@example.com",
          status: "revoked",
        },
      ]);
    });
    it("requires org:admin permission", async () => {
      await clearKVStores(env);
      await seedCachedApiKey(env, validKeyHash, {
        ...TEST_CACHED_API_KEY,
        permissions: ["org:read", "org:write"],
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
