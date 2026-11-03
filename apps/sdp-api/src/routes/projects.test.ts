/**
 * Projects Routes E2E Tests
 */

import { hashString } from "@sdp/payments/hash";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { ALL_API_KEY_GRANTS_SQL, TEST_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { clerkHeaders, clerkHeadersWithoutProject } from "@/test/helpers/clerk";
import { signSeededClerkMember } from "@/test/helpers/clerk-member";
import { env } from "@/test/helpers/env";
import { DEFAULT_PROJECT_NAME, seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

let clerkToken: string;

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
    clerkToken = await signSeededClerkMember(env, db, TEST_USER.id, TEST_ORG.id);

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
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, status)
         VALUES (?, ?, ?, ?, 'Test Key', ?, ?, ${ALL_API_KEY_GRANTS_SQL}, 'active')`
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
          headers: clerkHeadersWithoutProject(clerkToken),
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
          headers: clerkHeadersWithoutProject(clerkToken),
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
      await db
        .prepare("UPDATE organizations SET settings = NULL WHERE id = ?")
        .bind(TEST_ORG.id)
        .run();
      await db
        .prepare("UPDATE api_keys SET project_id = ? WHERE id = ?")
        .bind(TEST_PRODUCTION_PROJECT.id, TEST_API_KEY.id)
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
    it("refuses an API key, since project administration is `projects.manage`", async () => {
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

      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({
        error: { code: "INSUFFICIENT_PERMISSIONS", details: { action: "projects.manage" } },
      });
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

  // Project members are managed by a signed-in person only (HOO-2099).
  describe("Project Members", () => {
    const projectId = TEST_PROJECT.id;

    it("lists project members", async () => {
      const res = await app.request(
        `/v1/projects/${projectId}/members`,
        {
          headers: clerkHeaders(clerkToken, projectId),
        },
        env
      );

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.members).toBeInstanceOf(Array);
      // Creator should be added as admin
      expect(body.data.members.length).toBeGreaterThan(0);
    });
  });

  describe("Dashboard Clerk project access", () => {
    it("retains org-wide project listing and update access", async () => {
      await getDb(env)
        .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
        .bind(JSON.stringify({ enableProductionProject: true }), TEST_ORG.id)
        .run();
      const listRes = await app.request(
        "/v1/projects",
        { headers: clerkHeadersWithoutProject(clerkToken) },
        env
      );
      expect(listRes.status).toBe(200);
      const listBody = await listRes.json();
      expect(listBody.data.projects.map((project: { id: string }) => project.id)).toContain(
        TEST_PRODUCTION_PROJECT.id
      );

      const updateRes = await app.request(
        `/v1/projects/${TEST_PRODUCTION_PROJECT.id}`,
        {
          method: "PATCH",
          headers: {
            ...clerkHeaders(clerkToken, TEST_PRODUCTION_PROJECT.id),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Clerk Updated" }),
        },
        env
      );
      expect(updateRes.status).toBe(200);
    });
  });
});
