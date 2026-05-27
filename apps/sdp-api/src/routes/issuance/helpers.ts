import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

export const requireProjectScope = async (c: AppContext) => {
  const auth = getAuth(c);

  if (auth.projectId) {
    return { auth, projectId: auth.projectId, orgId: auth.organizationId };
  }

  if (auth.authType === "api_key") {
    throw new AppError("BAD_REQUEST", "Project-scoped API key required for token operations");
  }

  const requestedProjectId = c.req.query("projectId") ?? c.req.header("x-project-id") ?? null;

  if (requestedProjectId) {
    const project = await getDb(c.env)
      .prepare(
        `SELECT p.id
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE p.id = ? AND p.organization_id = ? AND p.status = 'active' AND pm.user_id = ?
         LIMIT 1`
      )
      .bind(requestedProjectId, auth.organizationId, auth.userId)
      .first<{ id: string }>();

    if (!project) {
      throw new AppError("FORBIDDEN", "Requested project is not accessible");
    }

    return { auth, projectId: requestedProjectId, orgId: auth.organizationId };
  }

  const sandboxProject = await getDb(c.env)
    .prepare(
      `SELECT p.id
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id
       WHERE p.organization_id = ? AND p.environment = 'sandbox' AND p.status = 'active' AND pm.user_id = ?
       LIMIT 1`
    )
    .bind(auth.organizationId, auth.userId)
    .first<{ id: string }>();

  if (!sandboxProject?.id) {
    throw new AppError("BAD_REQUEST", "No active sandbox project found for this organization.");
  }

  return { auth, projectId: sandboxProject.id, orgId: auth.organizationId };
};
