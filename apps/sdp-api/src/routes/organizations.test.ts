import { hashString } from "@sdp/payments/hash";
import type { Organization } from "@sdp/types/organizations";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { TEST_API_KEY, TEST_SEEDED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_MEMBER, TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { stubClerkBackend } from "@/test/helpers/clerk-backend";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { seedApiKeyRow, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

/** Organization administration is for a signed-in person (HOO-2099). */
let clerkToken: string;

async function seedOrganizationMember(role: "admin" | "member"): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 0, TEST_USER.status),
    getDb(env)
      .prepare(
        "INSERT INTO organization_members (id, organization_id, user_id, role, status) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(TEST_MEMBER.id, TEST_ORG.id, TEST_USER.id, role, "active"),
  ]);
  clerkToken = await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id);
}

async function setMemberRole(role: "admin" | "member"): Promise<void> {
  await getDb(env)
    .prepare("UPDATE organization_members SET role = ? WHERE organization_id = ? AND user_id = ?")
    .bind(role, TEST_ORG.id, TEST_USER.id)
    .run();
  clerkToken = await signSeededClerkMember(env, getDb(env), TEST_USER.id, TEST_ORG.id);
}

describe("Organizations routes", () => {
  let validKeyHash: string;
  beforeEach(async () => {
    await seedTestDatabase(env);
    validKeyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  });
  afterEach(async () => {
    await clearKVStores(env);
  });
  describe("GET /v1/organizations/:orgId", () => {
    beforeEach(async () => {
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
        .run();
      await seedApiKeyRow(env, validKeyHash, TEST_SEEDED_API_KEY);
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
    it("answers only the settings fields SDP defines, never a stored retired webhookSecret", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(
          JSON.stringify({ defaultEnvironment: "production", webhookSecret: "whsec_synthetic" }),
          TEST_ORG.id
        )
        .run();
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        { headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` } },
        env
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          id: TEST_ORG.id,
          name: TEST_ORG.name,
          slug: TEST_ORG.slug,
          tier: TEST_ORG.tier,
          status: TEST_ORG.status,
          settings: { defaultEnvironment: "production" },
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        meta: { requestId: expect.any(String), timestamp: expect.any(String) },
      });
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
    it("refuses a key whose organization's stored status is not one it knows", async () => {
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
      // Authentication admits only an `active` organization, so an unknown status
      // fails closed there rather than reaching the route.
      expect(res.status).toBe(401);
      const body = (await res.json()) as {
        error: {
          code: string;
        };
      };
      expect(body.error.code).toBe("REVOKED_API_KEY");
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
    it("refuses a key whose organization does not exist", async () => {
      // A key row cannot outlive its organization (ON DELETE CASCADE), so a
      // deleted organization row leaves an unknown key.
      await getDb(env).prepare("DELETE FROM organizations WHERE id = ?").bind(TEST_ORG.id).run();
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
        },
        env
      );
      expect(res.status).toBe(401);
    });
  });
  describe("PATCH /v1/organizations/:orgId", () => {
    beforeEach(async () => {
      await getDb(env)
        .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
        .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, TEST_ORG.tier, TEST_ORG.status)
        .run();
      await seedOrganizationMember("admin");
    });
    afterEach(() => {
      vi.restoreAllMocks();
      env.CLERK_API_URL = undefined;
      env.CLERK_SECRET_KEY = undefined;
    });
    it("commits a rename, then renames the Clerk organization to it", async () => {
      const clerk = stubClerkBackend(env);
      clerk.answer({ status: 200, body: { id: `clerk_org_${TEST_ORG.id}` } });
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${clerkToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "Updated Name",
          }),
        },
        env
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: {
          id: TEST_ORG.id,
          name: "Updated Name",
          slug: TEST_ORG.slug,
          tier: TEST_ORG.tier,
          status: TEST_ORG.status,
          settings: null,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
        },
        meta: { requestId: expect.any(String), timestamp: expect.any(String) },
      });
      expect(clerk.requests).toEqual([
        {
          method: "PATCH",
          path: `/organizations/clerk_org_${TEST_ORG.id}`,
          body: { name: "Updated Name" },
        },
      ]);
    });
    it("updates organization settings", async () => {
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${clerkToken}`,
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
            Authorization: `Bearer ${clerkToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        },
        env
      );
      expect(res.status).toBe(400);
    });
    it("requires org:write permission", async () => {
      await setMemberRole("member");
      const res = await app.request(
        `/v1/organizations/${TEST_ORG.id}`,
        {
          method: "PATCH",
          headers: {
            Authorization: `Bearer ${clerkToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "New Name" }),
        },
        env
      );
      expect(res.status).toBe(403);
    });
  });
});
