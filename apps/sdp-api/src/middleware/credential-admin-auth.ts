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
