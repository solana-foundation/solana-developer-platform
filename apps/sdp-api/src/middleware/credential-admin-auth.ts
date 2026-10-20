import type { Context, Next } from "hono";
import { canManageOrganizationCredentials, getAuth } from "@/lib/auth";
import { forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";
import { unifiedAuthMiddleware } from "./auth";

/**
 * Gate for custody credential administration: a signed-in person only, never
 * an API key. Each route behind it declares `wallets.configure`, which only an
 * organization administrator holds.
 *
 * @returns Hono middleware that authenticates the caller and refuses anything but a Clerk session.
 */
export function credentialAdminAuthMiddleware() {
  const authenticate = unifiedAuthMiddleware();

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await authenticate(c, async () => {
      if (!c.get("clerk")) {
        throw forbidden("Credential administration requires a signed-in user");
      }
      await next();
    });
  };
}

/**
 * Gate for surfaces that hold organization-wide egress endpoints rather than
 * signing material (Helius Rings connections), so they require an
 * organization administrator (HOO-1092); each route behind it also declares
 * `helius_rings.configure`. API keys are refused for the same reason as
 * custody: a credential administration surface must be tied to a person.
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
