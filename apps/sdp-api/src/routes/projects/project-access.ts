import type { Context, Next } from "hono";
import { getDb } from "@/db";
import { type ApiKeyContext, getAuth } from "@/lib/auth";
import { notFound } from "@/lib/errors";
import { findMemberProject } from "@/middleware/project-context";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

/**
 * API keys are scoped to exactly one project. Human dashboard actors keep
 * their organization-level project permissions and are authorized by the
 * individual handler's existing checks.
 */
export function assertApiKeyProjectAccess(auth: ApiKeyContext, projectId: string): void {
  if (auth.authType === "api_key" && auth.projectId !== projectId) {
    throw notFound("Project");
  }
}

/**
 * Apply API-key project binding to every path-scoped project route. Register
 * this for both the exact /:projectId route and all nested siblings.
 */
export function apiKeyProjectAccessMiddleware() {
  return async (c: AppContext, next: Next) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw notFound("Project");
    }

    assertApiKeyProjectAccess(getAuth(c), projectId);
    await next();
  };
}

/**
 * Admits a dashboard session (or approved-operation replay) to the project in
 * the path only when the project is active and the user is a member of it, the
 * rule `projectContextMiddleware` applies; anything else is a 404 so a
 * non-member cannot probe which projects exist. API keys are left to
 * `apiKeyProjectAccessMiddleware`'s binding. For routes that serve any project
 * member without a permission check.
 *
 * @returns Hono middleware that throws 404 for a session outside the project.
 */
export function projectMemberAccessMiddleware() {
  return async (c: AppContext, next: Next) => {
    const auth = getAuth(c);
    if (auth.authType !== "api_key") {
      const { projectId } = c.req.param();
      const project = await findMemberProject(getDb(c.env), {
        organizationId: auth.organizationId,
        userId: auth.userId,
        projectId,
      });
      if (!project) {
        throw notFound("Project");
      }
    }
    await next();
  };
}
