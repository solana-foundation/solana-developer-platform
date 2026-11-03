import type { ListProjectMembersResponse } from "@sdp/types/projects";
import type { Context } from "hono";
import { getDb } from "@/db/client";
import { getAuth } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { success } from "@/lib/response";
import { ProjectService } from "@/services/project.service";
import type { Env } from "@/types/env";

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
