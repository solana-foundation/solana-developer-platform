/**
 * Projects Routes E2E Tests
 */

import { hashString } from "@sdp/payments/hash";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { DEFAULT_PROJECT_NAME, seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

const TEST_SESSION_ID = "ses_test_projects";

describe("Projects Routes", () => {
  let apiKeyHash: string;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);

    // Pre-compute API key hash
    apiKeyHash = await hashString(
      TEST_API_KEY.raw,
      (env as { API_KEY_PEPPER: string }).API_KEY_PEPPER
    );
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    const kv = createKVStoreSet(env);

    // Clear rate limit KV to prevent 429 errors between tests
    const keys = await kv.rateLimits.list();
    for (const key of keys.keys) {
      await kv.rateLimits.delete(key.name);
    }

    // Delete in FK-safe order: api_keys → project_members → projects.
    // The migration added ON DELETE RESTRICT from api_keys.project_id, so
    // projects can't be wiped until referring keys are gone.
    await db.prepare("DELETE FROM api_keys").run();
    await db.prepare("DELETE FROM project_members").run();
    await db.prepare("DELETE FROM projects").run();

    // Seed organization
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    // Seed user
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();

    // Seed an org-admin dashboard session. Human actors intentionally retain
    // org-wide project management, even for projects they do not belong to.
    await db
      .prepare(
        `INSERT OR REPLACE INTO organization_members
         (id, organization_id, user_id, role, status)
         VALUES ('mem_test_projects', ?, ?, 'admin', 'active')`
      )
      .bind(TEST_ORG.id, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT OR REPLACE INTO sessions (id, user_id, organization_id, auth_method, expires_at)
         VALUES (?, ?, ?, 'session', ?)`
      )
      .bind(TEST_SESSION_ID, TEST_USER.id, TEST_ORG.id, new Date(Date.now() + 60_000).toISOString())
      .run();

    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: { sandbox: TEST_PROJECT.id, production: TEST_PRODUCTION_PROJECT.id },
    });

    // Seed API key with projects:write permission
    await db
      .prepare(
        `INSERT OR REPLACE INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Test Key', ?, ?, 'api_admin', '["*"]', 'active')`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        TEST_API_KEY.prefix,
        apiKeyHash
      )
      .run();

    // Cache API key in KV — override projectId so the cached actor scope
    // matches the project row we just seeded for this test suite.
    await kv.apiKeys.put(
      `key:${apiKeyHash}`,
      JSON.stringify({ ...TEST_CACHED_API_KEY, projectId: TEST_PROJECT.id })
    );
  });

  describe("POST /v1/projects", () => {
    it("is not routable", async () => {
      const res = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  describe("GET /v1/projects", () => {
    it("only lists the project bound to the API key", async () => {
      const res = await app.request(
        "/v1/projects",
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.projects.map((project: { id: string }) => project.id)).toEqual([
        TEST_PROJECT.id,
      ]);
    });

    it("excludes production projects when the org has no enableProductionProject setting", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET settings = NULL WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();
      const res = await app.request(
        "/v1/projects",
        {
          headers: { Cookie: `sdp_session=${TEST_SESSION_ID}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.data.projects.map((project: { id: string }) => project.id);
      expect(ids).toContain(TEST_PROJECT.id);
      expect(ids).not.toContain(TEST_PRODUCTION_PROJECT.id);
    });

    it("includes production projects when the org settings have enableProductionProject", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(JSON.stringify({ enableProductionProject: true }), TEST_ORG.id)
        .run();
      const res = await app.request(
        "/v1/projects",
        {
          headers: { Cookie: `sdp_session=${TEST_SESSION_ID}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const ids = body.data.projects.map((project: { id: string }) => project.id);
      expect(ids).toContain(TEST_PROJECT.id);
      expect(ids).toContain(TEST_PRODUCTION_PROJECT.id);
    });

    it("filters out the API key's own production project when the org is not enabled", async () => {
      const db = getDb(env);
      const kv = createKVStoreSet(env);
      await db
        .prepare("UPDATE organizations SET settings = NULL WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();
      await db
        .prepare("UPDATE api_keys SET project_id = ? WHERE id = ?")
        .bind(TEST_PRODUCTION_PROJECT.id, TEST_API_KEY.id)
        .run();
      await kv.apiKeys.put(
        `key:${apiKeyHash}`,
        JSON.stringify({
          ...TEST_CACHED_API_KEY,
          projectId: TEST_PRODUCTION_PROJECT.id,
          environment: "production",
        })
      );
      const res = await app.request(
        "/v1/projects",
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.projects).toEqual([]);
    });

    it("excludes archived projects by default", async () => {
      const db = getDb(env);

      await db
        .prepare("UPDATE projects SET status = 'archived' WHERE id = ?")
        .bind(TEST_PRODUCTION_PROJECT.id)
        .run();

      const res = await app.request(
        "/v1/projects",
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const archivedProject = body.data.projects.find(
        (p: { id: string }) => p.id === TEST_PRODUCTION_PROJECT.id
      );
      expect(archivedProject).toBeUndefined();
    });
  });

  describe("GET /v1/projects/:projectId", () => {
    it("returns the API key's project details", async () => {
      const res = await app.request(
        `/v1/projects/${TEST_PROJECT.id}`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.project.id).toBe(TEST_PROJECT.id);
      expect(body.data.project.name).toBe(DEFAULT_PROJECT_NAME.sandbox);
    });

    it("returns 404 for another project in the same organization", async () => {
      const res = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 for non-existent project", async () => {
      const res = await app.request(
        "/v1/projects/prj_nonexistent123",
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /v1/projects/:projectId", () => {
    it("updates the API key's project details", async () => {
      const res = await app.request(
        `/v1/projects/${TEST_PROJECT.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Updated Name",
            description: "New description",
          }),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.project.name).toBe("Updated Name");
      expect(body.data.project.description).toBe("New description");
    });

    it("returns 404 without modifying another project in the same organization", async () => {
      const res = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Updated Name",
            description: "New description",
          }),
        },
        env
      );

      expect(res.status).toBe(404);
      const project = await getDb(env)
        .prepare("SELECT name, description FROM projects WHERE id = ?")
        .bind(TEST_PRODUCTION_PROJECT.id)
        .first<{ name: string; description: string | null }>();
      expect(project).toEqual({ name: DEFAULT_PROJECT_NAME.production, description: null });
    });
  });

  describe("Project Members", () => {
    const projectId = TEST_PROJECT.id;
    const projectMemberId = `pm_${TEST_PROJECT.id}_${TEST_USER.id}`;

    it("lists project members", async () => {
      const res = await app.request(
        `/v1/projects/${projectId}/members`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.members).toBeInstanceOf(Array);
      // Creator should be added as admin
      expect(body.data.members.length).toBeGreaterThan(0);
    });

    it("adds a member to project", async () => {
      // Create another user
      const db = getDb(env);
      await db
        .prepare(
          "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES ('usr_member123', 'member@example.com', 1, 'active')"
        )
        .run();
      await db
        .prepare(
          "INSERT OR REPLACE INTO organization_members (id, organization_id, user_id, role, status) VALUES ('mem_member123', ?, 'usr_member123', 'developer', 'active')"
        )
        .bind(TEST_ORG.id)
        .run();

      const res = await app.request(
        `/v1/projects/${projectId}/members`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            userId: "usr_member123",
            role: "developer",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.member.userId).toBe("usr_member123");
      expect(body.data.member.role).toBe("developer");
    });

    it("returns 400 for non-org member", async () => {
      // Create user not in org
      const db = getDb(env);
      await db
        .prepare(
          "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES ('usr_outside123', 'outside@example.com', 1, 'active')"
        )
        .run();

      const res = await app.request(
        `/v1/projects/${projectId}/members`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ userId: "usr_outside123" }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("not a member of this organization");
    });

    it("updates and removes a member in the API key's project", async () => {
      const db = getDb(env);

      const updateRes = await app.request(
        `/v1/projects/${projectId}/members/${projectMemberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ role: "viewer" }),
        },
        env
      );
      expect(updateRes.status).toBe(204);

      const updated = await db
        .prepare("SELECT role FROM project_members WHERE id = ?")
        .bind(`pm_${TEST_PROJECT.id}_${TEST_USER.id}`)
        .first<{ role: string }>();
      expect(updated?.role).toBe("viewer");

      const deleteRes = await app.request(
        `/v1/projects/${projectId}/members/${projectMemberId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(deleteRes.status).toBe(204);

      const removed = await db
        .prepare("SELECT id FROM project_members WHERE id = ?")
        .bind(`pm_${TEST_PROJECT.id}_${TEST_USER.id}`)
        .first();
      expect(removed).toBeNull();
    });

    it("returns 404 for cross-project member reads", async () => {
      const res = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}/members`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(404);
    });

    it("returns 404 without adding an admin to another project", async () => {
      const db = getDb(env);
      await db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES ('usr_cross_add', 'cross-add@example.com', 1, 'active')"
        )
        .run();
      await db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_cross_add', ?, 'usr_cross_add', 'member', 'active')`
        )
        .bind(TEST_ORG.id)
        .run();

      const res = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}/members`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ userId: "usr_cross_add", role: "admin" }),
        },
        env
      );

      expect(res.status).toBe(404);
      const membership = await db
        .prepare(
          "SELECT role FROM project_members WHERE project_id = ? AND user_id = 'usr_cross_add'"
        )
        .bind(TEST_PRODUCTION_PROJECT.id)
        .first();
      expect(membership).toBeNull();
    });

    it("returns 404 without changing or removing another project's member", async () => {
      const db = getDb(env);
      const memberId = `pm_${TEST_PRODUCTION_PROJECT.id}_${TEST_USER.id}`;

      const updateRes = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}/members/${memberId}`,
        {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ role: "viewer" }),
        },
        env
      );
      expect(updateRes.status).toBe(404);

      const deleteRes = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}/members/${memberId}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(deleteRes.status).toBe(404);

      const membership = await db
        .prepare("SELECT role FROM project_members WHERE id = ?")
        .bind(memberId)
        .first<{ role: string }>();
      expect(membership?.role).toBe("admin");
    });
  });

  describe("Dashboard session project access", () => {
    const sessionHeaders = { Cookie: `sdp_session=${TEST_SESSION_ID}` };

    it("retains org-wide project listing and update access", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(JSON.stringify({ enableProductionProject: true }), TEST_ORG.id)
        .run();
      const listRes = await app.request("/v1/projects", { headers: sessionHeaders }, env);
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.data.projects.map((project: { id: string }) => project.id)).toContain(
        TEST_PRODUCTION_PROJECT.id
      );

      const updateRes = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}`,
        {
          method: "PATCH",
          headers: { ...sessionHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Session Updated" }),
        },
        env
      );
      expect(updateRes.status).toBe(200);
    });

    it("retains org-wide project member administration", async () => {
      const db = getDb(env);
      await db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES ('usr_session_member', 'session-member@example.com', 1, 'active')"
        )
        .run();
      await db
        .prepare(
          `INSERT INTO organization_members (id, organization_id, user_id, role, status)
           VALUES ('mem_session_member', ?, 'usr_session_member', 'member', 'active')`
        )
        .bind(TEST_ORG.id)
        .run();

      const res = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}/members`,
        {
          method: "POST",
          headers: { ...sessionHeaders, "Content-Type": "application/json" },
          body: JSON.stringify({ userId: "usr_session_member", role: "admin" }),
        },
        env
      );

      expect(res.status).toBe(201);
      const membership = await db
        .prepare(
          "SELECT role FROM project_members WHERE project_id = ? AND user_id = 'usr_session_member'"
        )
        .bind(TEST_PRODUCTION_PROJECT.id)
        .first<{ role: string }>();
      expect(membership?.role).toBe("admin");
    });
  });

  describe("Project API Keys", () => {
    // API keys are bound to a single project; use the same project the test key
    // belongs to so that assertProjectAccess passes.
    const projectId = TEST_PROJECT.id;

    it("creates API key for project", async () => {
      const res = await app.request(
        `/v1/projects/${projectId}/api-keys`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Project Key",
            walletScope: "all",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.apiKey.name).toBe("Project Key");
      expect(body.data.apiKey.key).toMatch(/^sk_test_/);
      expect(body.data.apiKey.id).toMatch(/^key_/);
    });

    it("lists API keys for project", async () => {
      // Create a key first
      await app.request(
        `/v1/projects/${projectId}/api-keys`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Listed Key", walletScope: "all" }),
        },
        env
      );

      const res = await app.request(
        `/v1/projects/${projectId}/api-keys`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.apiKeys).toBeInstanceOf(Array);
      expect(body.data.apiKeys.length).toBeGreaterThan(0);
    });

    it("returns 404 for API-key management on another project", async () => {
      const listRes = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}/api-keys`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(listRes.status).toBe(404);

      const createRes = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}/api-keys`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Cross-project key", walletScope: "all" }),
        },
        env
      );
      expect(createRes.status).toBe(404);
    });
  });
});
