/**
 * Project Service Unit Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DatabaseClient, getDb } from "@/db";
import { ProjectService } from "@/services/project.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PRODUCTION_PROJECT, TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import {
  DEFAULT_PROJECT_NAME,
  DEFAULT_PROJECT_SLUG,
  seedDefaultProjects,
} from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

describe("ProjectService", () => {
  let projectService: ProjectService;
  let db: DatabaseClient;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    db = getDb(env);
    projectService = new ProjectService(db);

    // Clear projects tables
    await db
      .prepare("DELETE FROM project_members")
      .run()
      .catch(() => {});
    await db
      .prepare("DELETE FROM projects")
      .run()
      .catch(() => {});

    // Seed org and user
    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    await seedDefaultProjects(db, {
      organizationId: TEST_ORG.id,
      createdBy: TEST_USER.id,
      members: [TEST_USER.id],
      ids: {
        sandbox: TEST_PROJECT.id,
        production: TEST_PRODUCTION_PROJECT.id,
      },
    });
  });

  describe("getProject", () => {
    it("returns project by ID", async () => {
      const project = await projectService.getProject(TEST_PROJECT.id);

      expect(project).not.toBeNull();
      expect(project?.id).toBe(TEST_PROJECT.id);
      expect(project?.name).toBe(DEFAULT_PROJECT_NAME.sandbox);
    });

    it("returns null for non-existent project", async () => {
      const project = await projectService.getProject("prj_nonexistent");

      expect(project).toBeNull();
    });
  });

  describe("getProjectBySlug", () => {
    it("returns project by slug within organization", async () => {
      const project = await projectService.getProjectBySlug(
        TEST_ORG.id,
        DEFAULT_PROJECT_SLUG.sandbox
      );

      expect(project).not.toBeNull();
      expect(project?.slug).toBe(DEFAULT_PROJECT_SLUG.sandbox);
    });
  });

  describe("listProjects", () => {
    it("lists all active projects for organization", async () => {
      const projects = await projectService.listProjects(TEST_ORG.id);

      expect(projects.length).toBe(2);
    });

    it("excludes archived projects by default", async () => {
      await db
        .prepare("UPDATE projects SET status = 'archived' WHERE id = ?")
        .bind(TEST_PROJECT.id)
        .run();

      const projects = await projectService.listProjects(TEST_ORG.id);

      expect(projects.find((p) => p.id === TEST_PROJECT.id)).toBeUndefined();
    });

    it("includes archived projects when requested", async () => {
      await db
        .prepare("UPDATE projects SET status = 'archived' WHERE id = ?")
        .bind(TEST_PROJECT.id)
        .run();

      const projects = await projectService.listProjects(TEST_ORG.id, {
        includeArchived: true,
      });

      expect(projects.find((p) => p.id === TEST_PROJECT.id)).toBeDefined();
    });
  });

  describe("updateProject", () => {
    it("updates project name", async () => {
      const updated = await projectService.updateProject(TEST_PROJECT.id, {
        name: "New Name",
      });

      expect(updated.name).toBe("New Name");
    });

    it("updates project settings", async () => {
      const updated = await projectService.updateProject(TEST_PROJECT.id, {
        settings: { webhookUrl: "https://new.example.com/webhook" },
      });

      expect(updated.settings?.webhookUrl).toBe("https://new.example.com/webhook");
    });

    it("defaults rpc provider to round robin when settings are omitted", async () => {
      const updated = await projectService.updateProject(TEST_PROJECT.id, {
        name: "Default RPC Provider Renamed",
      });

      expect(updated.settings?.rpcProvider).toBe("default");
    });

    it("preserves existing rpc provider when settings update omits it", async () => {
      await db
        .prepare("UPDATE projects SET settings = ? WHERE id = ?")
        .bind(JSON.stringify({ rpcProvider: "triton" }), TEST_PROJECT.id)
        .run();

      const updated = await projectService.updateProject(TEST_PROJECT.id, {
        settings: { webhookUrl: "https://updated.example.com/webhook" },
      });

      expect(updated.settings?.rpcProvider).toBe("triton");
    });

    it("switches provider to default and clears custom endpoint", async () => {
      await db
        .prepare("UPDATE projects SET settings = ? WHERE id = ?")
        .bind(
          JSON.stringify({
            rpcProvider: "custom",
            rpcEndpoint: "https://rpc.custom.example.com",
          }),
          TEST_PROJECT.id
        )
        .run();

      const updated = await projectService.updateProject(TEST_PROJECT.id, {
        settings: { rpcProvider: "default" },
      });

      expect(updated.settings?.rpcProvider).toBe("default");
      expect(updated.settings?.rpcEndpoint).toBeUndefined();
    });

    it("throws for non-existent project", async () => {
      await expect(
        projectService.updateProject("prj_nonexistent", { name: "Test" })
      ).rejects.toThrow("Project not found");
    });
  });

  describe("active project environment invariant", () => {
    it("rejects a second active project for the same organization and environment", async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
             VALUES ('prj_duplicate_sandbox', ?, 'Duplicate Sandbox', 'duplicate-sandbox', 'sandbox', 'active', ?)`
          )
          .bind(TEST_ORG.id, TEST_USER.id)
          .run()
      ).rejects.toMatchObject({ code: "23505" });
    });
  });

  describe("Project Members", () => {
    const projectId = TEST_PROJECT.id;

    describe("addMember", () => {
      it("adds a member with specified role", async () => {
        // Create another user
        await db
          .prepare(
            "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES ('usr_new123', 'new@example.com', 1, 'active')"
          )
          .run();

        const member = await projectService.addMember(projectId, "usr_new123", "developer");

        expect(member.id).toMatch(/^pm_/);
        expect(member.userId).toBe("usr_new123");
        expect(member.role).toBe("developer");
      });

      it("throws for duplicate membership", async () => {
        await db
          .prepare(
            "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES ('usr_dup123', 'dup@example.com', 1, 'active')"
          )
          .run();

        await projectService.addMember(projectId, "usr_dup123", "viewer");

        await expect(
          projectService.addMember(projectId, "usr_dup123", "developer")
        ).rejects.toThrow("User is already a member of this project");
      });
    });

    describe("updateMemberRole", () => {
      it("updates member role", async () => {
        await db
          .prepare(
            "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES ('usr_role123', 'role@example.com', 1, 'active')"
          )
          .run();

        await projectService.addMember(projectId, "usr_role123", "viewer");

        await projectService.updateMemberRole(projectId, "usr_role123", "developer");

        const membership = await projectService.getMembership(projectId, "usr_role123");
        expect(membership?.role).toBe("developer");
      });
    });

    describe("removeMember", () => {
      it("removes member from project", async () => {
        await db
          .prepare(
            "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES ('usr_remove123', 'remove@example.com', 1, 'active')"
          )
          .run();

        await projectService.addMember(projectId, "usr_remove123", "developer");

        await projectService.removeMember(projectId, "usr_remove123");

        const membership = await projectService.getMembership(projectId, "usr_remove123");
        expect(membership).toBeNull();
      });
    });

    describe("listMembers", () => {
      it("returns all project members with user details", async () => {
        const members = await projectService.listMembers(projectId);

        expect(members.length).toBeGreaterThan(0);
        expect(members[0].user).toBeDefined();
        expect(members[0].user.email).toBeDefined();
      });
    });
  });
});
