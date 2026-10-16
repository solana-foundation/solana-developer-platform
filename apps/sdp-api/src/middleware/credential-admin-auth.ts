import type { Context, Next } from "hono";
import { canManageOrganizationCredentials, getAuth } from "@/lib/auth";
import { forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";
import { requirePermissions, unifiedAuthMiddleware } from "./auth";

export function credentialAdminAuthMiddleware() {
  const authenticate = unifiedAuthMiddleware();
  const authorize = requirePermissions("custody:admin");

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await authenticate(c, async () => {
      if (!c.get("clerk")) {
        throw forbidden("Credential administration requires a signed-in user");
      }
      await authorize(c, next);
    });
  };
}

/**
 * Gate for surfaces that hold organization-wide egress endpoints rather than
 * signing material (Helius Rings connections), so they require `org:admin`
 * (HOO-1092) instead of `custody:admin`. API keys are refused for the same
 * reason as custody: a credential administration surface must be tied to a
 * person.
 *
 * @returns Hono middleware that authenticates the caller and requires an organization administrator.
 */
export function organizationCredentialAdminAuthMiddleware() {
  const authenticate = unifiedAuthMiddleware();

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await authenticate(c, async () => {
      if (!canManageOrganizationCredentials(getAuth(c))) {
        throw forbidden("Connection administration requires an organization administrator");
      }
      await next();
    });
  };
}
