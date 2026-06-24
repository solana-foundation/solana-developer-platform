import type { Context } from "hono";
import { getAuth, requireProjectId } from "@/lib/auth";
import type { Env } from "@/types/env";

export type AppContext = Context<{ Bindings: Env }>;

/**
 * Resolve project scope for issuance routes. The projectContextMiddleware
 * already validates project membership (or pins API key actors to their
 * own projectId) before this helper is reached, so we just unwrap the
 * resolved values here.
 */
export const requireProjectScope = (c: AppContext) => {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  return { auth, projectId, orgId: auth.organizationId };
};
