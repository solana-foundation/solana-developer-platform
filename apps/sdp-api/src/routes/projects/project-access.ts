import type { Context, Next } from "hono";
import { type ApiKeyContext, getAuth } from "@/lib/auth";
import { notFound } from "@/lib/errors";
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
