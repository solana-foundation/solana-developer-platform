import type { ListProjectMembersResponse, ProjectMemberResponse, ProjectRole } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { badRequest, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";
import type { addMemberSchema, updateMemberSchema } from "../schemas";

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

export const addProjectMember = async (c: ValidatedBodyContext<typeof addMemberSchema>) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const body = c.req.valid("json");

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
    .bind(body.userId, auth.organizationId)
    .first();

  if (!orgMember) {
    throw badRequest("User is not a member of this organization");
  }

  const member = await projectService.addMember(
    projectId,
    body.userId,
    (body.role ?? "developer") as ProjectRole
  );

  // Get user details
  const user = await getDb(c.env)
    .prepare("SELECT id, email, name FROM users WHERE id = ?")
    .bind(body.userId)
    .first<{ id: string; email: string; name: string | null }>();

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "create",
    resourceType: "project_member",
    resourceId: member.id,
    metadata: { projectId, userId: body.userId, role: member.role },
  });

  const response: ProjectMemberResponse = {
    member: {
      ...member,
      user: user ?? { id: body.userId, email: "", name: null },
    },
  };
  return created(c, response);
};

export const updateProjectMember = async (c: ValidatedBodyContext<typeof updateMemberSchema>) => {
  const { projectId, memberId } = c.req.param();
  const auth = getAuth(c);

  const body = c.req.valid("json");

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

  await projectService.updateMemberRole(projectId, memberRow.user_id, body.role as ProjectRole);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "project_member",
    resourceId: memberId,
    metadata: { role: body.role },
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
