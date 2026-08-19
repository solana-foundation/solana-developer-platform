import type { Context, Next } from "hono";
import { forbidden } from "@/lib/errors";
import type { Env } from "@/types/env";
import { requirePermissions, unifiedAuthMiddleware } from "./auth";

export function credentialAdminAuthMiddleware() {
  const authenticate = unifiedAuthMiddleware({ allowClerk: true, allowSession: true });
  const authorize = requirePermissions("custody:admin");

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await authenticate(c, async () => {
      if (c.get("apiKey")) {
        throw forbidden("Credential administration does not accept API keys");
      }
      await authorize(c, next);
    });
  };
}

/**
 * RPC connections hold organization-wide egress credentials rather than
 * signing material, so they gate on `org:admin` (HOO-1092) instead of
 * `custody:admin`. API keys are refused for the same reason as custody: a
 * credential administration surface must be tied to a person.
 */
export function rpcAdminAuthMiddleware() {
  const authenticate = unifiedAuthMiddleware({ allowClerk: true, allowSession: true });
  const authorize = requirePermissions("org:admin");

  return async (c: Context<{ Bindings: Env }>, next: Next) => {
    await authenticate(c, async () => {
      if (c.get("apiKey")) {
        throw forbidden("RPC connection administration does not accept API keys");
      }
      await authorize(c, next);
    });
  };
}
