import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth, requireProjectId } from "@/lib/auth";
import { getRequestTenantScope } from "@/lib/tenant-scope";
import { TokenService } from "@/services/token.service";
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

/**
 * The only tenant-facing TokenService construction path. Its scope comes from
 * authenticated middleware state, never request-controlled headers or bodies.
 */
export const getTenantTokenService = (c: AppContext): TokenService =>
  new TokenService(getDb(c.env), getRequestTenantScope(c));
