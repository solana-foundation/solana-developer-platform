import type { ListProjectsResponse, ProjectResponse, UpdateProjectRequest } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { noContent, success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { AuditService } from "@/services/audit.service";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";
import type { updateProjectSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const listProjects = async (c: AppContext) => {
  const auth = getAuth(c);
  const includeArchived = c.req.query("includeArchived") === "true";

  const projectService = new ProjectService(getDb(c.env));
  let projectList: ListProjectsResponse["projects"];

  if (auth.authType === "api_key") {
    if (!auth.projectId) {
      throw notFound("Project");
    }

    const project = await projectService.getProject(auth.projectId);
    if (!project || project.organizationId !== auth.organizationId) {
      throw notFound("Project");
    }

    projectList = includeArchived || project.status === "active" ? [project] : [];
  } else {
    projectList = await projectService.listProjects(auth.organizationId, { includeArchived });
  }

  const response: ListProjectsResponse = { projects: projectList };
  return success(c, response);
};

export const getProject = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const projectService = new ProjectService(getDb(c.env));
  const project = await projectService.getProject(projectId);

  if (!project || project.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  const response: ProjectResponse = { project };
  return success(c, response);
};

export const updateProject = async (c: ValidatedBodyContext<typeof updateProjectSchema>) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const body = c.req.valid("json");

  const projectService = new ProjectService(getDb(c.env));

  // Verify ownership
  const existing = await projectService.getProject(projectId);
  if (!existing || existing.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  const project = await projectService.updateProject(projectId, body as UpdateProjectRequest);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "project",
    resourceId: projectId,
    metadata: body,
  });

  const response: ProjectResponse = { project };
  return success(c, response);
};

export const archiveProject = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const projectService = new ProjectService(getDb(c.env));

  // Verify ownership
  const existing = await projectService.getProject(projectId);
  if (!existing || existing.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  const deactivatedKeyHashes = await projectService.archiveProject(projectId);
  // The transaction above already revoked the keys; purging their cache
  // entries makes that effective immediately instead of at TTL expiry.
  for (const keyHash of deactivatedKeyHashes) {
    await c.var.kv.apiKeys.delete(`key:${keyHash}`);
  }

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "project",
    resourceId: projectId,
  });

  return noContent(c);
};
