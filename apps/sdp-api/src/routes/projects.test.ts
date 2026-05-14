/**
 * Projects Routes E2E Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import app from "@/index";
import { hashString } from "@/lib/hash";
import { createKVStoreSet } from "@/runtime/factory";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

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

    // Clear projects tables
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});

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

    // Seed API key with projects:write permission
    await db
      .prepare(
        `INSERT OR REPLACE INTO api_keys
         (id, organization_id, created_by, name, key_prefix, key_hash, role, permissions, environment, status)
         VALUES (?, ?, ?, 'Test Key', ?, ?, 'api_admin', '["*"]', 'sandbox', 'active')`
      )
      .bind(TEST_API_KEY.id, TEST_ORG.id, TEST_USER.id, TEST_API_KEY.prefix, apiKeyHash)
      .run();

    // Cache API key in KV
    await kv.apiKeys.put(`key:${apiKeyHash}`, JSON.stringify(TEST_CACHED_API_KEY));
  });

  describe("POST /v1/projects", () => {
    it("creates a new project", async () => {
      const res = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "My Project",
            description: "A test project",
            environment: "sandbox",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.project).toBeDefined();
      expect(body.data.project.name).toBe("My Project");
      expect(body.data.project.slug).toBe("my-project");
      expect(body.data.project.id).toMatch(/^prj_/);
      expect(body.data.project.status).toBe("active");
    });

    it("creates project with custom slug", async () => {
      const res = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({
            name: "Custom Slug Project",
            slug: "custom-slug",
          }),
        },
        env
      );

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.data.project.slug).toBe("custom-slug");
    });

    it("returns 400 for duplicate slug", async () => {
      // Create first project
      await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "First Project", slug: "duplicate" }),
        },
        env
      );

      // Try to create another with same slug
      const res = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Second Project", slug: "duplicate" }),
        },
        env
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain("slug already exists");
    });

    it("returns 401 without auth", async () => {
      const res = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Test" }),
        },
        env
      );

      expect(res.status).toBe(401);
    });
  });

  describe("GET /v1/projects", () => {
    it("lists projects for organization", async () => {
      // Create a project first
      await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Listed Project" }),
        },
        env
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
      expect(body.data.projects).toBeInstanceOf(Array);
      expect(body.data.projects.length).toBeGreaterThan(0);
      expect(body.data.projects[0].name).toBe("Listed Project");
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
      // Create a project first
      const createRes = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Detail Project" }),
        },
        env
      );
      const created = await createRes.json();
      const projectId = created.data.project.id;

      const res = await app.request(
        `/v1/projects/${projectId}`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.project.id).toBe(projectId);
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
      // Create a project first
      const createRes = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Update Me" }),
        },
        env
      );
      const created = await createRes.json();
      const projectId = created.data.project.id;

      const res = await app.request(
        `/v1/projects/${projectId}`,
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
      // Create a project first
      const createRes = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Delete Me" }),
        },
        env
      );
      const created = await createRes.json();
      const projectId = created.data.project.id;

      const res = await app.request(
        `/v1/projects/${projectId}`,
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
        .bind(projectId)
        .first<{ status: string }>();
      expect(project?.status).toBe("archived");
    });
  });

  describe("Project Members", () => {
    let projectId: string;

    beforeEach(async () => {
      // Create a project for member tests
      const createRes = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "Member Test Project" }),
        },
        env
      );
      const created = await createRes.json();
      projectId = created.data.project.id;
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
    let projectId: string;

    beforeEach(async () => {
      // Use unique slug per test run
      const uniqueSlug = `api-key-proj-${Date.now()}`;
      const createRes = await app.request(
        "/v1/projects",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TEST_API_KEY.raw}`,
          },
          body: JSON.stringify({ name: "API Key Project", slug: uniqueSlug }),
        },
        env
      );
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      projectId = created.data.project.id;
    });

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
            environment: "sandbox",
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
