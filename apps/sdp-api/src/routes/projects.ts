/**
 * Projects Routes
 *
 * Manages projects and project members within organizations.
 */

import { generateApiKey, generateApiKeyId, hashString } from "@/lib/crypto";
import { AppError, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { authMiddleware, requirePermissions } from "@/middleware/auth";
import { AuditService } from "@/services/audit.service";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";
import type {
  ApiKeyRole,
  CreateApiKeyResponse,
  ListProjectMembersResponse,
  ListProjectsResponse,
  ProjectMemberResponse,
  ProjectResponse,
  ProjectRole,
  UpdateProjectRequest,
} from "@sdp/types";
import { Hono } from "hono";
import { z } from "zod";

const projects = new Hono<{ Bindings: Env }>();

// All routes require authentication
projects.use("*", authMiddleware());

// Validation schemas
const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().max(500).optional(),
  environment: z.enum(["sandbox", "beta", "production"]).optional(),
  settings: z
    .object({
      rpcEndpoint: z.string().url().optional(),
      webhookUrl: z.string().url().optional(),
      metadata: z.record(z.string()).optional(),
    })
    .optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  environment: z.enum(["sandbox", "beta", "production"]).optional(),
  settings: z
    .object({
      rpcEndpoint: z.string().url().optional(),
      webhookUrl: z.string().url().optional(),
      metadata: z.record(z.string()).optional(),
    })
    .nullable()
    .optional(),
});

const addMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(["admin", "developer", "viewer"]).optional(),
});

const updateMemberSchema = z.object({
  role: z.enum(["admin", "developer", "viewer"]),
});

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  role: z.enum(["api_admin", "api_developer", "api_readonly"]).optional(),
  environment: z.enum(["sandbox", "production"]).optional(),
  allowedIps: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Project CRUD
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new project
 * POST /v1/projects
 */
projects.post("/", requirePermissions("projects:write"), async (c) => {
  const auth = c.get("apiKey");
  const orgId = auth!.organizationId;

  const body = await c.req.json();
  const parsed = createProjectSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  // Get the user who created this key (for created_by)
  const creatorKey = await c.env.DB.prepare("SELECT created_by FROM api_keys WHERE id = ?")
    .bind(auth!.id)
    .first<{ created_by: string }>();

  const projectService = new ProjectService(c.env.DB);

  try {
    const project = await projectService.createProject({
      organizationId: orgId,
      createdBy: creatorKey?.created_by ?? "system",
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description,
      environment: parsed.data.environment,
      settings: parsed.data.settings,
    });

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "create",
      resourceType: "project",
      resourceId: project.id,
      metadata: { name: project.name, slug: project.slug },
    });

    const response: ProjectResponse = { project };
    return created(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "DUPLICATE_SLUG") {
      throw new AppError("BAD_REQUEST", "A project with this slug already exists");
    }
    throw error;
  }
});

/**
 * List projects
 * GET /v1/projects
 */
projects.get("/", requirePermissions("projects:read"), async (c) => {
  const auth = c.get("apiKey");
  const includeArchived = c.req.query("includeArchived") === "true";

  const projectService = new ProjectService(c.env.DB);
  const projectList = await projectService.listProjects(auth!.organizationId, { includeArchived });

  const response: ListProjectsResponse = { projects: projectList };
  return success(c, response);
});

/**
 * Get project by ID
 * GET /v1/projects/:projectId
 */
projects.get("/:projectId", requirePermissions("projects:read"), async (c) => {
  const { projectId } = c.req.param();
  const auth = c.get("apiKey");

  const projectService = new ProjectService(c.env.DB);
  const project = await projectService.getProject(projectId);

  if (!project || project.organizationId !== auth!.organizationId) {
    throw notFound("Project");
  }

  const response: ProjectResponse = { project };
  return success(c, response);
});

/**
 * Update project
 * PATCH /v1/projects/:projectId
 */
projects.patch("/:projectId", requirePermissions("projects:write"), async (c) => {
  const { projectId } = c.req.param();
  const auth = c.get("apiKey");

  const body = await c.req.json();
  const parsed = updateProjectSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectService = new ProjectService(c.env.DB);

  // Verify ownership
  const existing = await projectService.getProject(projectId);
  if (!existing || existing.organizationId !== auth!.organizationId) {
    throw notFound("Project");
  }

  const project = await projectService.updateProject(
    projectId,
    parsed.data as UpdateProjectRequest
  );

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "update",
    resourceType: "project",
    resourceId: projectId,
    metadata: parsed.data,
  });

  const response: ProjectResponse = { project };
  return success(c, response);
});

/**
 * Archive project
 * DELETE /v1/projects/:projectId
 */
projects.delete("/:projectId", requirePermissions("projects:admin"), async (c) => {
  const { projectId } = c.req.param();
  const auth = c.get("apiKey");

  const projectService = new ProjectService(c.env.DB);

  // Verify ownership
  const existing = await projectService.getProject(projectId);
  if (!existing || existing.organizationId !== auth!.organizationId) {
    throw notFound("Project");
  }

  await projectService.archiveProject(projectId);

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "delete",
    resourceType: "project",
    resourceId: projectId,
  });

  return noContent(c);
});

// ═══════════════════════════════════════════════════════════════════════════
// Project Members
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List project members
 * GET /v1/projects/:projectId/members
 */
projects.get("/:projectId/members", requirePermissions("project-members:read"), async (c) => {
  const { projectId } = c.req.param();
  const auth = c.get("apiKey");

  const projectService = new ProjectService(c.env.DB);

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth!.organizationId) {
    throw notFound("Project");
  }

  const members = await projectService.listMembers(projectId);

  const response: ListProjectMembersResponse = { members };
  return success(c, response);
});

/**
 * Add project member
 * POST /v1/projects/:projectId/members
 */
projects.post("/:projectId/members", requirePermissions("project-members:write"), async (c) => {
  const { projectId } = c.req.param();
  const auth = c.get("apiKey");

  const body = await c.req.json();
  const parsed = addMemberSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectService = new ProjectService(c.env.DB);

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth!.organizationId) {
    throw notFound("Project");
  }

  // Verify user is a member of the organization
  const orgMember = await c.env.DB.prepare(
    "SELECT id FROM organization_members WHERE user_id = ? AND organization_id = ? AND status = 'active'"
  )
    .bind(parsed.data.userId, auth!.organizationId)
    .first();

  if (!orgMember) {
    throw new AppError("BAD_REQUEST", "User is not a member of this organization");
  }

  try {
    const member = await projectService.addMember(
      projectId,
      parsed.data.userId,
      (parsed.data.role ?? "developer") as ProjectRole
    );

    // Get user details
    const user = await c.env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?")
      .bind(parsed.data.userId)
      .first<{ id: string; email: string; name: string | null }>();

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "create",
      resourceType: "project_member",
      resourceId: member.id,
      metadata: { projectId, userId: parsed.data.userId, role: member.role },
    });

    const response: ProjectMemberResponse = {
      member: {
        ...member,
        user: user ?? { id: parsed.data.userId, email: "", name: null },
      },
    };
    return created(c, response);
  } catch (error) {
    if (error instanceof Error && error.message === "ALREADY_MEMBER") {
      throw new AppError("BAD_REQUEST", "User is already a member of this project");
    }
    throw error;
  }
});

/**
 * Update project member role
 * PATCH /v1/projects/:projectId/members/:memberId
 */
projects.patch(
  "/:projectId/members/:memberId",
  requirePermissions("project-members:write"),
  async (c) => {
    const { projectId, memberId } = c.req.param();
    const auth = c.get("apiKey");

    const body = await c.req.json();
    const parsed = updateMemberSchema.safeParse(body);

    if (!parsed.success) {
      throw new AppError("BAD_REQUEST", "Invalid request body", {
        errors: parsed.error.flatten().fieldErrors,
      });
    }

    const projectService = new ProjectService(c.env.DB);

    // Verify project belongs to org
    const project = await projectService.getProject(projectId);
    if (!project || project.organizationId !== auth!.organizationId) {
      throw notFound("Project");
    }

    // Get member to find userId
    const memberRow = await c.env.DB.prepare(
      "SELECT user_id FROM project_members WHERE id = ? AND project_id = ?"
    )
      .bind(memberId, projectId)
      .first<{ user_id: string }>();

    if (!memberRow) {
      throw notFound("Project member");
    }

    await projectService.updateMemberRole(
      projectId,
      memberRow.user_id,
      parsed.data.role as ProjectRole
    );

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "update",
      resourceType: "project_member",
      resourceId: memberId,
      metadata: { role: parsed.data.role },
    });

    return noContent(c);
  }
);

/**
 * Remove project member
 * DELETE /v1/projects/:projectId/members/:memberId
 */
projects.delete(
  "/:projectId/members/:memberId",
  requirePermissions("project-members:write"),
  async (c) => {
    const { projectId, memberId } = c.req.param();
    const auth = c.get("apiKey");

    const projectService = new ProjectService(c.env.DB);

    // Verify project belongs to org
    const project = await projectService.getProject(projectId);
    if (!project || project.organizationId !== auth!.organizationId) {
      throw notFound("Project");
    }

    // Get member to find userId
    const memberRow = await c.env.DB.prepare(
      "SELECT user_id FROM project_members WHERE id = ? AND project_id = ?"
    )
      .bind(memberId, projectId)
      .first<{ user_id: string }>();

    if (!memberRow) {
      throw notFound("Project member");
    }

    await projectService.removeMember(projectId, memberRow.user_id);

    // Audit log
    const auditService = new AuditService(c.env.DB);
    await auditService.log(c, {
      action: "delete",
      resourceType: "project_member",
      resourceId: memberId,
    });

    return noContent(c);
  }
);

// ═══════════════════════════════════════════════════════════════════════════
// Project API Keys
// ═══════════════════════════════════════════════════════════════════════════

/**
 * List API keys for a project
 * GET /v1/projects/:projectId/api-keys
 */
projects.get("/:projectId/api-keys", requirePermissions("api-keys:read"), async (c) => {
  const { projectId } = c.req.param();
  const auth = c.get("apiKey");

  const projectService = new ProjectService(c.env.DB);

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth!.organizationId) {
    throw notFound("Project");
  }

  const results = await c.env.DB.prepare(
    `SELECT id, name, description, key_prefix, role, environment, status,
            last_used_at, expires_at, created_at
     FROM api_keys
     WHERE project_id = ? AND status != 'revoked'
     ORDER BY created_at DESC`
  )
    .bind(projectId)
    .all();

  return success(c, {
    apiKeys: results.results.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      description: row.description as string | null,
      keyPrefix: row.key_prefix as string,
      role: row.role as ApiKeyRole,
      environment: row.environment as "sandbox" | "production",
      status: row.status as "active" | "revoked" | "expired",
      lastUsedAt: row.last_used_at as string | null,
      expiresAt: row.expires_at as string | null,
      createdAt: row.created_at as string,
    })),
  });
});

/**
 * Create API key for a project
 * POST /v1/projects/:projectId/api-keys
 */
projects.post("/:projectId/api-keys", requirePermissions("api-keys:write"), async (c) => {
  const { projectId } = c.req.param();
  const auth = c.get("apiKey");

  const body = await c.req.json();
  const parsed = createKeySchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectService = new ProjectService(c.env.DB);

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth!.organizationId) {
    throw notFound("Project");
  }

  const {
    name,
    description,
    role = "api_developer",
    environment = "sandbox",
    allowedIps,
    expiresAt,
  } = parsed.data;

  // Generate key
  const keyId = generateApiKeyId();
  const { key, prefix } = generateApiKey(environment);
  const keyHash = await hashString(key, c.env.API_KEY_PEPPER);

  // Get creator
  const creatorKey = await c.env.DB.prepare("SELECT created_by FROM api_keys WHERE id = ?")
    .bind(auth!.id)
    .first<{ created_by: string }>();

  await c.env.DB.prepare(
    `INSERT INTO api_keys (
      id, organization_id, project_id, created_by, name, description, key_prefix, key_hash,
      role, environment, allowed_ips, expires_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  )
    .bind(
      keyId,
      auth!.organizationId,
      projectId,
      creatorKey?.created_by ?? "system",
      name,
      description ?? null,
      prefix,
      keyHash,
      role,
      environment,
      allowedIps ? JSON.stringify(allowedIps) : null,
      expiresAt ?? null
    )
    .run();

  // Audit log
  const auditService = new AuditService(c.env.DB);
  await auditService.log(c, {
    action: "create",
    resourceType: "api_key",
    resourceId: keyId,
    metadata: { projectId, name, role, environment },
  });

  const response: CreateApiKeyResponse = {
    apiKey: {
      id: keyId,
      name,
      key, // Full key - only shown once!
      keyPrefix: prefix,
      role,
      environment,
      expiresAt: expiresAt ?? null,
      createdAt: new Date().toISOString(),
    },
  };

  return created(c, response);
});

export default projects;
