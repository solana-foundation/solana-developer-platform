/**
 * Project Service
 *
 * Manages projects within organizations.
 * Projects group API keys by team or environment.
 */

import type {
  Project,
  ProjectEnvironment,
  ProjectMember,
  ProjectRole,
  ProjectSettings,
} from "@sdp/types";

export interface CreateProjectInput {
  organizationId: string;
  createdBy: string;
  name: string;
  slug?: string;
  description?: string;
  environment?: ProjectEnvironment;
  settings?: ProjectSettings;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  settings?: ProjectSettings | null;
}

export type ProjectServiceErrorCode = "DUPLICATE_SLUG" | "ALREADY_MEMBER" | "NOT_FOUND";

export class ProjectServiceError extends Error {
  constructor(
    public readonly code: ProjectServiceErrorCode,
    message?: string
  ) {
    super(message ?? code);
    // biome-ignore lint/security/noSecrets: error name constant
    this.name = "ProjectServiceError";
  }
}

export class ProjectService {
  constructor(private db: DatabaseClient) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Project CRUD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new project
   */
  async createProject(input: CreateProjectInput): Promise<Project> {
    const id = `prj_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const slug = input.slug ?? this.generateSlug(input.name);

    // Check for slug uniqueness within organization
    const existing = await this.db
      .prepare("SELECT id FROM projects WHERE organization_id = ? AND slug = ?")
      .bind(input.organizationId, slug)
      .first();

    if (existing) {
      throw new ProjectServiceError("DUPLICATE_SLUG");
    }

    const project: Project = {
      id,
      organizationId: input.organizationId,
      name: input.name,
      slug,
      description: input.description ?? null,
      environment: input.environment ?? "sandbox",
      settings: this.resolveProjectSettings(input.settings),
      status: "active",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    const memberId = `pm_${crypto.randomUUID()}`;
    const memberRole: ProjectRole = "admin";

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, description, environment, settings, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          project.id,
          project.organizationId,
          project.name,
          project.slug,
          project.description,
          project.environment,
          project.settings ? JSON.stringify(project.settings) : null,
          project.status,
          project.createdBy,
          project.createdAt,
          project.updatedAt
        ),
      this.db
        .prepare(
          `INSERT INTO project_members (id, project_id, user_id, role, created_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(memberId, id, input.createdBy, memberRole, now),
    ]);

    return project;
  }

  /**
   * Get a project by ID
   */
  async getProject(projectId: string): Promise<Project | null> {
    const row = await this.db
      .prepare(
        `SELECT id, organization_id, name, slug, description, environment, settings, status, created_by, created_at, updated_at
         FROM projects
         WHERE id = ?`
      )
      .bind(projectId)
      .first<{
        id: string;
        organization_id: string;
        name: string;
        slug: string;
        description: string | null;
        environment: string;
        settings: string | null;
        status: string;
        created_by: string;
        created_at: string;
        updated_at: string;
      }>();

    if (!row) {
      return null;
    }

    return this.mapRowToProject(row);
  }

  /**
   * Get a project by slug within an organization
   */
  async getProjectBySlug(organizationId: string, slug: string): Promise<Project | null> {
    const row = await this.db
      .prepare(
        `SELECT id, organization_id, name, slug, description, environment, settings, status, created_by, created_at, updated_at
         FROM projects
         WHERE organization_id = ? AND slug = ?`
      )
      .bind(organizationId, slug)
      .first<{
        id: string;
        organization_id: string;
        name: string;
        slug: string;
        description: string | null;
        environment: string;
        settings: string | null;
        status: string;
        created_by: string;
        created_at: string;
        updated_at: string;
      }>();

    if (!row) {
      return null;
    }

    return this.mapRowToProject(row);
  }

  /**
   * List all projects in an organization
   */
  async listProjects(
    organizationId: string,
    options: { includeArchived?: boolean } = {}
  ): Promise<Project[]> {
    const statusFilter = options.includeArchived ? "" : "AND status = 'active'";

    const result = await this.db
      .prepare(
        `SELECT id, organization_id, name, slug, description, environment, settings, status, created_by, created_at, updated_at
         FROM projects
         WHERE organization_id = ? ${statusFilter}
         ORDER BY created_at DESC`
      )
      .bind(organizationId)
      .all<{
        id: string;
        organization_id: string;
        name: string;
        slug: string;
        description: string | null;
        environment: string;
        settings: string | null;
        status: string;
        created_by: string;
        created_at: string;
        updated_at: string;
      }>();

    return result.results.map((row) => this.mapRowToProject(row));
  }

  /**
   * List projects a user is a member of
   */
  async listUserProjects(userId: string, organizationId: string): Promise<Project[]> {
    const result = await this.db
      .prepare(
        `SELECT p.id, p.organization_id, p.name, p.slug, p.description, p.environment, p.settings, p.status, p.created_by, p.created_at, p.updated_at
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = ? AND p.organization_id = ? AND p.status = 'active'
         ORDER BY p.created_at DESC`
      )
      .bind(userId, organizationId)
      .all<{
        id: string;
        organization_id: string;
        name: string;
        slug: string;
        description: string | null;
        environment: string;
        settings: string | null;
        status: string;
        created_by: string;
        created_at: string;
        updated_at: string;
      }>();

    return result.results.map((row) => this.mapRowToProject(row));
  }

  /**
   * Update a project
   */
  async updateProject(projectId: string, input: UpdateProjectInput): Promise<Project> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      throw new ProjectServiceError("NOT_FOUND");
    }

    const now = new Date().toISOString();
    const updates: string[] = [];
    const values: (string | null)[] = [];

    if (input.name !== undefined) {
      updates.push("name = ?");
      values.push(input.name);
    }

    if (input.description !== undefined) {
      updates.push("description = ?");
      values.push(input.description);
    }

    if (input.settings !== undefined) {
      updates.push("settings = ?");
      const normalizedSettings =
        input.settings === null
          ? this.resolveProjectSettings(undefined)
          : this.resolveProjectSettings(
              {
                ...(existing.settings ?? {}),
                ...input.settings,
              },
              existing.settings
            );
      values.push(JSON.stringify(normalizedSettings));
    }

    updates.push("updated_at = ?");
    values.push(now);
    values.push(projectId);

    await this.db
      .prepare(`UPDATE projects SET ${updates.join(", ")} WHERE id = ?`)
      .bind(...values)
      .run();

    const updated = await this.getProject(projectId);
    if (!updated) {
      throw new ProjectServiceError("NOT_FOUND");
    }

    return updated;
  }

  /**
   * Archive a project (soft delete)
   */
  async archiveProject(projectId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare("UPDATE projects SET status = 'archived', updated_at = ? WHERE id = ?")
      .bind(now, projectId)
      .run();
  }

  /**
   * Ensure a default project exists for the given environment and that the user
   * is a member. Idempotent — safe to call on every authenticated request.
   *
   * @param organizationId - Organization to provision under
   * @param environment - "sandbox" or "production"
   * @param createdBy - User ID used as creator and initial member
   * @returns The project ID (existing or newly created)
   */
  async findOrCreateDefault(
    organizationId: string,
    environment: ProjectEnvironment,
    createdBy: string
  ): Promise<string> {
    const slug = environment === "sandbox" ? "default-sandbox" : "default-production";
    const name =
      environment === "sandbox" ? "Default Sandbox Project" : "Default Production Project";
    const description =
      environment === "sandbox" ? "Default sandbox project" : "Default production project";

    await this.db
      .prepare(
        `INSERT INTO projects
           (id, organization_id, name, slug, description, environment, settings, status, created_by, created_at, updated_at)
         VALUES ('prj_' || gen_random_uuid(), ?, ?, ?, ?, ?, NULL, 'active', ?, sdp_datetime_now(), sdp_datetime_now())
         ON CONFLICT (organization_id, slug) DO NOTHING`
      )
      .bind(organizationId, name, slug, description, environment, createdBy)
      .run();

    const project = await this.db
      .prepare(`SELECT id FROM projects WHERE organization_id = ? AND slug = ?`)
      .bind(organizationId, slug)
      .first<{ id: string }>();

    if (!project) {
      throw new ProjectServiceError(
        "NOT_FOUND",
        `Failed to provision default ${environment} project`
      );
    }

    await this.db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES ('pm_' || gen_random_uuid(), ?, ?, 'admin', sdp_datetime_now())
         ON CONFLICT (project_id, user_id) DO NOTHING`
      )
      .bind(project.id, createdBy)
      .run();

    return project.id;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Project Members
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add a member to a project
   */
  async addMember(projectId: string, userId: string, role: ProjectRole): Promise<ProjectMember> {
    // Check if already a member
    const existing = await this.getMembership(projectId, userId);
    if (existing) {
      throw new ProjectServiceError("ALREADY_MEMBER");
    }

    const id = `pm_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const member: ProjectMember = {
      id,
      projectId,
      userId,
      role,
      createdAt: now,
    };

    await this.db
      .prepare(
        `INSERT INTO project_members (id, project_id, user_id, role, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .bind(member.id, member.projectId, member.userId, member.role, member.createdAt)
      .run();

    return member;
  }

  /**
   * Update a member's role
   */
  async updateMemberRole(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await this.db
      .prepare("UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?")
      .bind(role, projectId, userId)
      .run();
  }

  /**
   * Remove a member from a project
   */
  async removeMember(projectId: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ?")
      .bind(projectId, userId)
      .run();
  }

  /**
   * Get a user's membership in a project
   */
  async getMembership(projectId: string, userId: string): Promise<ProjectMember | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project_id, user_id, role, created_at
         FROM project_members
         WHERE project_id = ? AND user_id = ?`
      )
      .bind(projectId, userId)
      .first<{
        id: string;
        project_id: string;
        user_id: string;
        role: string;
        created_at: string;
      }>();

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      role: row.role as ProjectRole,
      createdAt: row.created_at,
    };
  }

  /**
   * List all members of a project
   */
  async listMembers(
    projectId: string
  ): Promise<Array<ProjectMember & { user: { id: string; email: string; name: string | null } }>> {
    const result = await this.db
      .prepare(
        `SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.created_at,
                u.email, u.name
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ?
         ORDER BY pm.created_at ASC`
      )
      .bind(projectId)
      .all<{
        id: string;
        project_id: string;
        user_id: string;
        role: string;
        created_at: string;
        email: string;
        name: string | null;
      }>();

    return result.results.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      role: row.role as ProjectRole,
      createdAt: row.created_at,
      user: {
        id: row.user_id,
        email: row.email,
        name: row.name,
      },
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  private generateSlug(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50);
  }

  private mapRowToProject(row: {
    id: string;
    organization_id: string;
    name: string;
    slug: string;
    description: string | null;
    environment: string;
    settings: string | null;
    status: string;
    created_by: string;
    created_at: string;
    updated_at: string;
  }): Project {
    let settings: ProjectSettings | undefined;
    if (row.settings) {
      try {
        settings = JSON.parse(row.settings) as ProjectSettings;
      } catch {
        settings = undefined;
      }
    }

    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      environment: row.environment as ProjectEnvironment,
      settings: this.resolveProjectSettings(settings),
      status: row.status as "active" | "archived",
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private resolveProjectSettings(
    settings?: ProjectSettings | null,
    fallbackSettings?: ProjectSettings | null
  ): ProjectSettings {
    const resolved: ProjectSettings = {
      ...(settings ?? {}),
    };

    if (resolved.rpcProvider === undefined) {
      resolved.rpcProvider =
        fallbackSettings?.rpcProvider ?? (resolved.rpcEndpoint ? "custom" : "default");
    }

    if (
      resolved.rpcProvider === "custom" &&
      resolved.rpcEndpoint === undefined &&
      fallbackSettings?.rpcEndpoint
    ) {
      resolved.rpcEndpoint = fallbackSettings.rpcEndpoint;
    }

    if (resolved.rpcProvider !== "custom") {
      resolved.rpcEndpoint = undefined;
    }

    return resolved;
  }
}
