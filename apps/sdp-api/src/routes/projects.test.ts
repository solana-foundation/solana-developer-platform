/**
 * Projects Routes E2E Tests
 */

import { hashString } from "@sdp/payments/hash";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { createKVStoreSet } from "@/runtime/factory";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

const TEST_PROJECT = {
  id: "prj_test_projects",
  slug: "test-test-org-projects",
};

/**
 * Inserts a project row plus a creator admin membership, mirroring what
 * default-project provisioning produces.
 */
async function seedProject(id: string, name: string, slug: string) {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', 'active', ?)`
      )
      .bind(id, TEST_ORG.id, name, slug, TEST_USER.id),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'admin', ?)`
      )
      .bind(`pm_${id}`, id, TEST_USER.id, new Date().toISOString()),
  ]);
}

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
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
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

    // Seed a default project so the API key has a parent project
    await db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT.id, TEST_ORG.id, TEST_PROJECT.slug, TEST_USER.id)
      .run();

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
    it("lists projects for organization", async () => {
      await seedProject("prj_listed123", "Listed Project", "listed-project");

      const res = await app.request(
        "/v1/projects",
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      const listed = body.data.projects.find((p: { id: string }) => p.id === "prj_listed123");
      expect(listed.name).toBe("Listed Project");
    });

    it("excludes archived projects by default", async () => {
      const db = getDb(env);

      // Create and archive a project directly
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES ('prj_archived123', ?, 'Archived Project', 'archived', 'sandbox', 'archived', ?)`
        )
        .bind(TEST_ORG.id, TEST_USER.id)
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
        (p: { id: string }) => p.id === "prj_archived123"
      );
      expect(archivedProject).toBeUndefined();
    });
  });

  describe("GET /v1/projects/:projectId", () => {
    it("returns project details", async () => {
      await seedProject("prj_detail123", "Detail Project", "detail-project");

      const res = await app.request(
        "/v1/projects/prj_detail123",
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.project.id).toBe("prj_detail123");
      expect(body.data.project.name).toBe("Detail Project");
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
    it("updates project details", async () => {
      await seedProject("prj_update123", "Update Me", "update-me");

      const res = await app.request(
        "/v1/projects/prj_update123",
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
  });

  describe("DELETE /v1/projects/:projectId", () => {
    it("archives a project", async () => {
      await seedProject("prj_delete123", "Delete Me", "delete-me");

      const res = await app.request(
        "/v1/projects/prj_delete123",
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(204);

      // Verify project is archived (not deleted)
      const db = getDb(env);
      const project = await db
        .prepare("SELECT status FROM projects WHERE id = ?")
        .bind("prj_delete123")
        .first<{ status: string }>();
      expect(project?.status).toBe("archived");
    });
  });

  describe("Project Members", () => {
    const projectId = "prj_members123";

    beforeEach(async () => {
      await seedProject(projectId, "Member Test Project", "member-test-project");
    });

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
  });
});
