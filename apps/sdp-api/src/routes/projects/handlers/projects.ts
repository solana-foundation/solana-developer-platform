import type { ListProjectsResponse, ProjectResponse, UpdateProjectRequest } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, notFound } from "@/lib/errors";
import { created, noContent, success } from "@/lib/response";
import { AuditService } from "@/services/audit.service";
import { ProjectService, ProjectServiceError } from "@/services/project.service";
import type { Env } from "@/types/env";
import { createProjectSchema, updateProjectSchema } from "../schemas";

type AppContext = Context<{ Bindings: Env }>;

export const createProject = async (c: AppContext) => {
  const auth = getAuth(c);
  const orgId = auth.organizationId;

  const body = await c.req.json();
  const parsed = createProjectSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const resolveCreatorUserId = async (): Promise<string | null> => {
    if (auth.userId) {
      return auth.userId;
    }

    if (!auth.apiKeyId) {
      return null;
    }

    const creator = await getDb(c.env)
      .prepare("SELECT created_by FROM api_keys WHERE id = ?")
      .bind(auth.apiKeyId)
      .first<{ created_by: string }>();

    return creator?.created_by ?? null;
  };

  const creatorUserId = await resolveCreatorUserId();

  if (!creatorUserId) {
    throw new AppError("UNAUTHORIZED", "Could not resolve authenticated user for project creation");
  }

  const projectService = new ProjectService(getDb(c.env));

  try {
    const project = await projectService.createProject({
      organizationId: orgId,
      createdBy: creatorUserId,
      name: parsed.data.name,
      slug: parsed.data.slug,
      description: parsed.data.description,
      environment: parsed.data.environment,
      settings: parsed.data.settings,
    });

    // Audit log
    const auditService = new AuditService(getDb(c.env));
    await auditService.log(c, {
      action: "create",
      resourceType: "project",
      resourceId: project.id,
      metadata: { name: project.name, slug: project.slug },
    });

    const response: ProjectResponse = { project };
    return created(c, response);
  } catch (error) {
    if (error instanceof ProjectServiceError && error.code === "DUPLICATE_SLUG") {
      throw new AppError("BAD_REQUEST", "A project with this slug already exists");
    }
    throw error;
  }
};

export const listProjects = async (c: AppContext) => {
  const auth = getAuth(c);
  const includeArchived = c.req.query("includeArchived") === "true";

  const projectService = new ProjectService(getDb(c.env));
  const projectList = await projectService.listProjects(auth.organizationId, { includeArchived });

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

export const updateProject = async (c: AppContext) => {
  const { projectId } = c.req.param();
  const auth = getAuth(c);

  const body = await c.req.json();
  const parsed = updateProjectSchema.safeParse(body);

  if (!parsed.success) {
    throw new AppError("BAD_REQUEST", "Invalid request body", {
      errors: parsed.error.flatten().fieldErrors,
    });
  }

  const projectService = new ProjectService(getDb(c.env));

  // Verify ownership
  const existing = await projectService.getProject(projectId);
  if (!existing || existing.organizationId !== auth.organizationId) {
    throw notFound("Project");
  }

  const project = await projectService.updateProject(
    projectId,
    parsed.data as UpdateProjectRequest
  );

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "update",
    resourceType: "project",
    resourceId: projectId,
    metadata: parsed.data,
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

  await projectService.archiveProject(projectId);

  // Audit log
  const auditService = new AuditService(getDb(c.env));
  await auditService.log(c, {
    action: "delete",
    resourceType: "project",
    resourceId: projectId,
  });

  return noContent(c);
};
