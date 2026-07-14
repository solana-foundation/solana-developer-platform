/**
 * Project Service Unit Tests
 */

import type { ProjectSettings } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { ProjectService } from "@/services/project.service";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";

/**
 * Inserts a project row plus a creator admin membership, mirroring what
 * default-project provisioning produces.
 */
async function seedProject(
  id: string,
  name: string,
  slug: string,
  settings: ProjectSettings | null
): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, settings, status, created_by)
         VALUES (?, ?, ?, ?, 'sandbox', ?, 'active', ?)`
      )
      .bind(
        id,
        TEST_ORG.id,
        name,
        slug,
        settings === null ? null : JSON.stringify(settings),
        TEST_USER.id
      ),
    db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, 'admin', ?)`
      )
      .bind(`pm_${id}`, id, TEST_USER.id, new Date().toISOString()),
  ]);
}

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

  describe("getProject", () => {
    it("returns project by ID", async () => {
      await seedProject("prj_get_test", "Get Test", "get-test", null);

      const project = await projectService.getProject("prj_get_test");

      expect(project).not.toBeNull();
      expect(project?.id).toBe("prj_get_test");
      expect(project?.name).toBe("Get Test");
    });

    it("returns null for non-existent project", async () => {
      const project = await projectService.getProject("prj_nonexistent");

      expect(project).toBeNull();
    });
  });

  describe("getProjectBySlug", () => {
    it("returns project by slug within organization", async () => {
      await seedProject("prj_slug_test", "Slug Test", "slug-test", null);

      const project = await projectService.getProjectBySlug(TEST_ORG.id, "slug-test");

      expect(project).not.toBeNull();
      expect(project?.slug).toBe("slug-test");
    });
  });

  describe("listProjects", () => {
    it("lists all active projects for organization", async () => {
      await seedProject("prj_list_1", "Project 1", "project-1", null);
      await seedProject("prj_list_2", "Project 2", "project-2", null);

      const projects = await projectService.listProjects(TEST_ORG.id);

      expect(projects.length).toBe(2);
    });

    it("excludes archived projects by default", async () => {
      await seedProject("prj_archive_default", "To Archive", "to-archive-default", null);
      await projectService.archiveProject("prj_archive_default");

      const projects = await projectService.listProjects(TEST_ORG.id);

      expect(projects.find((p) => p.id === "prj_archive_default")).toBeUndefined();
    });

    it("includes archived projects when requested", async () => {
      await seedProject("prj_archived_one", "Archived One", "archived-one", null);
      await projectService.archiveProject("prj_archived_one");

      const projects = await projectService.listProjects(TEST_ORG.id, {
        includeArchived: true,
      });

      expect(projects.find((p) => p.id === "prj_archived_one")).toBeDefined();
    });
  });

  describe("updateProject", () => {
    it("updates project name", async () => {
      await seedProject("prj_update_name", "Original Name", "original-name", null);

      const updated = await projectService.updateProject("prj_update_name", {
        name: "New Name",
      });

      expect(updated.name).toBe("New Name");
    });

    it("updates project settings", async () => {
      await seedProject("prj_update_settings", "Settings Update", "settings-update", null);

      const updated = await projectService.updateProject("prj_update_settings", {
        settings: { webhookUrl: "https://new.example.com/webhook" },
      });

      expect(updated.settings?.webhookUrl).toBe("https://new.example.com/webhook");
    });

    it("defaults rpc provider to round robin when settings are omitted", async () => {
      await seedProject("prj_default_rpc", "Default RPC Provider", "default-rpc-provider", null);

      const updated = await projectService.updateProject("prj_default_rpc", {
        name: "Default RPC Provider Renamed",
      });

      expect(updated.settings?.rpcProvider).toBe("default");
    });

    it("preserves existing rpc provider when settings update omits it", async () => {
      await seedProject("prj_preserve_rpc", "Preserve RPC Provider", "preserve-rpc-provider", {
        rpcProvider: "triton",
      });

      const updated = await projectService.updateProject("prj_preserve_rpc", {
        settings: { webhookUrl: "https://updated.example.com/webhook" },
      });

      expect(updated.settings?.rpcProvider).toBe("triton");
    });

    it("switches provider to default and clears custom endpoint", async () => {
      await seedProject("prj_switch_rpc", "Switch RPC Provider", "switch-rpc-provider", {
        rpcProvider: "custom",
        rpcEndpoint: "https://rpc.custom.example.com",
      });

      const updated = await projectService.updateProject("prj_switch_rpc", {
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

  describe("archiveProject", () => {
    it("sets project status to archived", async () => {
      await seedProject("prj_to_archive", "To Archive", "to-archive", null);

      await projectService.archiveProject("prj_to_archive");

      const archived = await projectService.getProject("prj_to_archive");
      expect(archived?.status).toBe("archived");
    });
  });

  describe("Project Members", () => {
    const projectId = "prj_member_test";

    beforeEach(async () => {
      await seedProject(projectId, "Member Test Project", "member-test-project", null);
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
