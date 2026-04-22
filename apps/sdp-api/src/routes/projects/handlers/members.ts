import type { ListProjectMembersResponse, ProjectMemberResponse, ProjectRole } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { ProjectService, ProjectServiceError } from "@/services/project.service";
import type { Env } from "@/types/env";
import { addMemberSchema, updateMemberSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const listProjectMembers = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const projectService = new ProjectService(getDb(c.env));

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  const members = await projectService.listMembers(projectId);

  const response: ListProjectMembersResponse = { members };
  return success(c, response);
};

export const addProjectMember = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = addMemberSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectService = new ProjectService(getDb(c.env));

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  // Verify user is a member of the organization
  const orgMember = await getDb(c.env)
    .prepare(
      "SELECT id FROM organization_members WHERE user_id = ? AND organization_id = ? AND status = 'active'"
    )
    .bind(parsed.data.userId, auth.organizationId)
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
    const user = await getDb(c.env)
      .prepare("SELECT id, email, name FROM users WHERE id = ?")
      .bind(parsed.data.userId)
      .first<{ id: string; email: string; name: string | null }>();

    // Audit log
    const auditService = new AuditService(getDb(c.env));
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
    if (error instanceof ProjectServiceError && error.code === "ALREADY_MEMBER") {
      throw new AppError("BAD_REQUEST", "User is already a member of this project");
    }
    throw error;
  }
};

export const updateProjectMember = async (c: AppContext) => {
  const { projectId, memberId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateMemberSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectService = new ProjectService(getDb(c.env));

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  // Get member to find userId
  const memberRow = await getDb(c.env)
    .prepare("SELECT user_id FROM project_members WHERE id = ? AND project_id = ?")
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
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "project_member",
    resourceId: memberId,
    metadata: { role: parsed.data.role },
  });

  return noContent(c);
};

export const removeProjectMember = async (c: AppContext) => {
  const { projectId, memberId } = c.req.param();
  const auth = getAuth(c);

  const projectService = new ProjectService(getDb(c.env));

  // Verify project belongs to org
  const project = await projectService.getProject(projectId);
  if (!project || project.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  // Get member to find userId
  const memberRow = await getDb(c.env)
    .prepare("SELECT user_id FROM project_members WHERE id = ? AND project_id = ?")
    .bind(memberId, projectId)
    .first<{ user_id: string }>();

  if (!memberRow) {
    throw notFound("Project member");
  }

  await projectService.removeMember(projectId, memberRow.user_id);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "project_member",
    resourceId: memberId,
  });

  return noContent(c);
};
