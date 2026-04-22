/**
 * Project Service Unit Tests
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { ProjectService } from "@/services/project.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

describe("ProjectService", () => {
  let projectService: ProjectService;
  let db: DatabaseClient;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
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
  });

  describe("createProject", () => {
    it("creates a project with auto-generated slug", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "My Test Project",
      });

      expect(project.id).toMatch(/^prj_/);
      expect(project.name).toBe("My Test Project");
      expect(project.slug).toBe("my-test-project");
      expect(project.status).toBe("active");
      expect(project.organizationId).toBe(TEST_ORG.id);
    });

    it("creates a project with custom slug", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Custom",
        slug: "my-custom-slug",
      });

      expect(project.slug).toBe("my-custom-slug");
    });

    it("defaults rpc provider to round robin when settings are omitted", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Default RPC Provider",
      });

      expect(project.settings?.rpcProvider).toBe("default");
    });

    it("creates a project with settings", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "With Settings",
        settings: {
          rpcEndpoint: "https://api.mainnet-beta.solana.com",
          webhookUrl: "https://example.com/webhook",
        },
      });

      expect(project.settings).not.toBeNull();
      expect(project.settings?.rpcEndpoint).toBe("https://api.mainnet-beta.solana.com");
    });

    it("adds creator as admin member", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Creator Test",
      });

      const membership = await projectService.getMembership(project.id, TEST_USER.id);

      expect(membership).not.toBeNull();
      expect(membership?.role).toBe("admin");
    });

    it("throws on duplicate slug", async () => {
      await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "First",
        slug: "duplicate-slug",
      });

      await expect(
        projectService.createProject({
          organizationId: TEST_ORG.id,
          createdBy: TEST_USER.id,
          name: "Second",
          slug: "duplicate-slug",
        })
      ).rejects.toThrow("DUPLICATE_SLUG");
    });
  });

  describe("getProject", () => {
    it("returns project by ID", async () => {
      const created = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Get Test",
      });

      const project = await projectService.getProject(created.id);

      expect(project).not.toBeNull();
      expect(project?.id).toBe(created.id);
      expect(project?.name).toBe("Get Test");
    });

    it("returns null for non-existent project", async () => {
      const project = await projectService.getProject("prj_nonexistent");

      expect(project).toBeNull();
    });
  });

  describe("getProjectBySlug", () => {
    it("returns project by slug within organization", async () => {
      await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Slug Test",
        slug: "slug-test",
      });

      const project = await projectService.getProjectBySlug(TEST_ORG.id, "slug-test");

      expect(project).not.toBeNull();
      expect(project?.slug).toBe("slug-test");
    });
  });

  describe("listProjects", () => {
    it("lists all active projects for organization", async () => {
      await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Project 1",
      });
      await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Project 2",
      });

      const projects = await projectService.listProjects(TEST_ORG.id);

      expect(projects.length).toBe(2);
    });

    it("excludes archived projects by default", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "To Archive",
      });
      await projectService.archiveProject(project.id);

      const projects = await projectService.listProjects(TEST_ORG.id);

      expect(projects.find((p) => p.id === project.id)).toBeUndefined();
    });

    it("includes archived projects when requested", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Archived One",
      });
      await projectService.archiveProject(project.id);

      const projects = await projectService.listProjects(TEST_ORG.id, {
        includeArchived: true,
      });

      expect(projects.find((p) => p.id === project.id)).toBeDefined();
    });
  });

  describe("updateProject", () => {
    it("updates project name", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Original Name",
      });

      const updated = await projectService.updateProject(project.id, {
        name: "New Name",
      });

      expect(updated.name).toBe("New Name");
    });

    it("updates project settings", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Settings Update",
      });

      const updated = await projectService.updateProject(project.id, {
        settings: { webhookUrl: "https://new.example.com/webhook" },
      });

      expect(updated.settings?.webhookUrl).toBe("https://new.example.com/webhook");
    });

    it("preserves existing rpc provider when settings update omits it", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Preserve RPC Provider",
        settings: {
          rpcProvider: "triton",
        },
      });

      const updated = await projectService.updateProject(project.id, {
        settings: { webhookUrl: "https://updated.example.com/webhook" },
      });

      expect(updated.settings?.rpcProvider).toBe("triton");
    });

    it("switches provider to default and clears custom endpoint", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Switch RPC Provider",
        settings: {
          rpcProvider: "custom",
          rpcEndpoint: "https://rpc.custom.example.com",
        },
      });

      const updated = await projectService.updateProject(project.id, {
        settings: { rpcProvider: "default" },
      });

      expect(updated.settings?.rpcProvider).toBe("default");
      expect(updated.settings?.rpcEndpoint).toBeUndefined();
    });

    it("throws for non-existent project", async () => {
      await expect(
        projectService.updateProject("prj_nonexistent", { name: "Test" })
      ).rejects.toThrow("NOT_FOUND");
    });
  });

  describe("archiveProject", () => {
    it("sets project status to archived", async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "To Archive",
      });

      await projectService.archiveProject(project.id);

      const archived = await projectService.getProject(project.id);
      expect(archived?.status).toBe("archived");
    });
  });

  describe("Project Members", () => {
    let projectId: string;

    beforeEach(async () => {
      const project = await projectService.createProject({
        organizationId: TEST_ORG.id,
        createdBy: TEST_USER.id,
        name: "Member Test Project",
      });
      projectId = project.id;
    });

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
        ).rejects.toThrow("ALREADY_MEMBER");
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
